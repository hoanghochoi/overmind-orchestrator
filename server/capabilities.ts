import type { PaseoApi } from "@getpaseo/client";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { z } from "zod";
import { roleForProvider } from "../shared/providers.js";
import { createNotebookActions, NOTEBOOK_ACTION_SCHEMAS } from "./actions/notebook.js";
import { projectRoot } from "./project-history.js";
import { COORDINATION_TOOLS, toolsForRole, type Coordinator } from "./coordination.js";
import { assertNotebookSupervisor, NOTEBOOK_TOOLS } from "./modules/causal_notebook.js";

const grantSchema = z.object({
  id: z.uuid(),
  token: z.string().length(64),
  agentId: z.string().nullable(),
});
const accessSchema = z.object({
  port: z.number().int().min(0).max(65535),
  grants: z.array(grantSchema),
});
export const NOTEBOOK_SERVER = "overmind_notebook";
export const COORDINATION_SERVER = "overmind";
export const SUPERVISOR_WAKE_SERVER = "overmind_wake";
export const CAPABILITY_ENV = "OVERMIND_CAPABILITY_ID";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function failure(error: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: error instanceof Error ? error.message : "Action failed" },
    ],
  };
}

/**
 * Local MCP endpoint for Overmind seats. A grant is provisioned at agent.create,
 * bound to the agent at session-open, and every request rechecks the live seat.
 */
export class CapabilityService {
  private readonly server: Server;
  private saving: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly requests = new Set<Promise<void>>();
  private constructor(
    private readonly accessPath: string,
    private readonly access: z.infer<typeof accessSchema>,
    private readonly paseo: PaseoApi,
    private readonly coordinator: Coordinator,
  ) {
    this.server = createServer((request, response) => {
      const pending = this.handle(request, response)
        .catch((error: unknown) => {
          if (!response.headersSent) response.writeHead(403, { "Content-Type": "text/plain" });
          response.end(error instanceof Error ? error.message : "Overmind request denied");
        })
        .finally(() => {
          this.requests.delete(pending);
        });
      this.requests.add(pending);
    });
  }

  static async open(
    accessPath: string,
    paseo: PaseoApi,
    coordinator: Coordinator,
  ): Promise<CapabilityService> {
    await mkdir(dirname(accessPath), { recursive: true });
    let access: z.infer<typeof accessSchema> = { port: 0, grants: [] };
    try {
      access = accessSchema.parse(JSON.parse(await readFile(accessPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const service = new CapabilityService(accessPath, access, paseo, coordinator);
    await new Promise<void>((resolve, reject) => {
      service.server.once("error", reject);
      service.server.listen(access.port, "127.0.0.1", () => {
        service.server.off("error", reject);
        resolve();
      });
    });
    const address = service.server.address();
    if (!address || typeof address === "string")
      throw new Error("Overmind MCP endpoint unavailable");
    access.port = address.port;
    try {
      await service.save();
    } catch (error) {
      await service.close();
      throw error;
    }
    return service;
  }

  private save(): Promise<unknown> {
    const saved = this.saving.then(async () => {
      const temporary = `${this.accessPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.access), { mode: 0o600 });
      await rename(temporary, this.accessPath);
      return undefined;
    });
    this.saving = saved.catch(() => undefined);
    return saved;
  }

  /** Replace stale Overmind servers with a fresh grant for a Supervisor or Lead. */
  async prepare(config: AgentSessionConfig) {
    const mcpServers = { ...config.mcpServers };
    delete mcpServers[NOTEBOOK_SERVER];
    delete mcpServers[COORDINATION_SERVER];
    const role = roleForProvider(config.provider);
    if (role !== "supervisor" && role !== "lead") return { mcpServers, capabilityId: null };
    const grant = { id: randomUUID(), token: randomBytes(32).toString("hex"), agentId: null };
    this.access.grants.push(grant);
    await this.save();
    const server = (path: string) => ({
      type: "http" as const,
      url: `http://127.0.0.1:${this.access.port}/${path}/${grant.id}`,
      headers: { Authorization: `Bearer ${grant.token}` },
    });
    mcpServers[COORDINATION_SERVER] = server("overmind");
    if (role === "supervisor") mcpServers[NOTEBOOK_SERVER] = server("notebook");
    return { mcpServers, capabilityId: grant.id };
  }

  async bind(id: string, principal: { provider: string; agentId: string }): Promise<void> {
    const role = roleForProvider(principal.provider);
    const grant = this.access.grants.find((item) => item.id === id);
    if (
      (role !== "supervisor" && role !== "lead") ||
      !grant ||
      (grant.agentId && grant.agentId !== principal.agentId)
    )
      throw new Error("OVERMIND_CAPABILITY_DENIED: invalid session binding");
    grant.agentId = principal.agentId;
    await this.save();
  }

  supervisorWakeServer(id: string, agentId: string) {
    const grant = this.access.grants.find((item) => item.id === id && item.agentId === agentId);
    if (!grant) throw new Error("OVERMIND_CAPABILITY_DENIED: bound Supervisor grant required");
    return {
      type: "http" as const,
      url: `http://127.0.0.1:${this.access.port}/wake/${grant.id}`,
      headers: { Authorization: `Bearer ${grant.token}` },
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (
      this.closed ||
      request.headers.host !== `127.0.0.1:${this.access.port}` ||
      request.headers.origin
    )
      throw new Error("OVERMIND_CAPABILITY_DENIED: invalid endpoint origin");
    const [, kind, id] = /^\/(overmind|notebook|wake)\/([^/?#]+)$/.exec(request.url ?? "") ?? [];
    const grant = this.access.grants.find(
      (item) => item.id === id && request.headers.authorization === `Bearer ${item.token}`,
    );
    if (!kind || !grant?.agentId)
      throw new Error("OVERMIND_CAPABILITY_DENIED: bound Overmind seat required");
    const agentId = grant.agentId;
    const mcp =
      kind === "notebook"
        ? await this.notebookServer(agentId)
        : await this.coordinationServer(agentId, kind === "wake");
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
  }

  private async activeSeat(agentId: string) {
    const current = await this.paseo.agents.ref(agentId).refresh();
    if (!current || current.agent.archivedAt)
      throw new Error("OVERMIND_CAPABILITY_DENIED: inactive Overmind seat");
    return { provider: current.agent.provider, agentId: current.agent.id };
  }

  private async coordinationServer(agentId: string, wakeOnly = false): Promise<McpServer> {
    const role = roleForProvider((await this.activeSeat(agentId)).provider);
    if (role !== "supervisor" && role !== "lead")
      throw new Error("OVERMIND_CAPABILITY_DENIED: Supervisor or Lead required");
    if (wakeOnly && role !== "supervisor")
      throw new Error("OVERMIND_CAPABILITY_DENIED: Supervisor wake requires a Supervisor");
    const names = wakeOnly ? ["create_supervisor_wake" as const] : toolsForRole(role);
    const mcp = new McpServer(
      { name: COORDINATION_SERVER, version: "1" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: names.map((name) => ({
        name,
        description: COORDINATION_TOOLS[name].description,
        inputSchema: {
          ...z.toJSONSchema(COORDINATION_TOOLS[name].schema),
          type: "object" as const,
        },
      })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
      try {
        if (wakeOnly && call.params.name !== "create_supervisor_wake")
          throw new Error("OVERMIND_ROLE_DENIED: only create_supervisor_wake is available");
        return result(
          await this.coordinator.call(agentId, call.params.name, call.params.arguments),
        );
      } catch (error) {
        return failure(error);
      }
    });
    return mcp;
  }

  private async notebookServer(agentId: string): Promise<McpServer> {
    const principal = await this.activeSeat(agentId);
    assertNotebookSupervisor(principal);
    const actions = createNotebookActions(
      (id) => projectRoot(this.paseo, id),
      dirname(this.accessPath),
    );
    const mcp = new McpServer(
      { name: NOTEBOOK_SERVER, version: "1" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: NOTEBOOK_TOOLS.map((name) => ({
        name,
        description:
          "Supervisor-only durable governance notebook; protocol proposals require owner review.",
        inputSchema: { ...z.toJSONSchema(NOTEBOOK_ACTION_SCHEMAS[name]), type: "object" as const },
      })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
      try {
        const name = NOTEBOOK_TOOLS.find((tool) => tool === call.params.name);
        if (!name) throw new Error("Unknown notebook action");
        assertNotebookSupervisor(await this.activeSeat(agentId));
        return result(await actions.get(name)!(principal, call.params.arguments));
      } catch (error) {
        return failure(error);
      }
    });
    return mcp;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.allSettled(this.requests);
    await this.saving;
  }
}
