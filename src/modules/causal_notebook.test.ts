import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CausalNotebook, NOTEBOOK_TOOLS, type CausalObservation } from "./causal_notebook.js";
import { createNotebookActions } from "../actions/notebook.js";
import { CapabilityService } from "../../server/capabilities.js";
import { Coordinator } from "../../server/coordination.js";
import { CreationTickets } from "../../server/policy.js";
import { Relay } from "../../server/relay.js";
import { SeatStore } from "../../server/seat-store.js";
import { DetectionLog } from "../../server/detection-log.js";
import { RepetitionTracker } from "../../server/repetition.js";
import { IntentStore } from "../../server/intent-store.js";
import { captureNotebookAlert } from "../../server/notebook-capture.js";
import { DetectionMonitor } from "../../server/detection.js";
import { OVERMIND_EVENT_ALERT } from "../../server/hybrid_sensor.js";
import { overmindSettings } from "../../shared/settings.js";
import { SkillFilteringEngine } from "./skills_engine.js";

vi.mock("../../server/embedding.js", () => ({
  configureEmbeddingRuntime: vi.fn(),
  encodeTexts: vi.fn(async () => [
    [1, 0],
    [1, 0],
  ]),
}));

const supervisor = { provider: "overmind-supervisor", agentId: "supervisor" };
const observation: CausalObservation = {
  workspace_id: "project",
  session_id: "session-1",
  observation: "Repeated waiting",
  evidence: [
    {
      kind: "tool_output",
      content: "quota exhausted\nRetry later",
      metadata: { score: 0.9, nested: [true, null] },
    },
  ],
  suspected_mechanism: "quota exhaustion",
  impact: "Review stalled",
  recommendation: "Choose an available model before retrying",
  protocol_candidate: true,
  anti_pattern: "waiting",
};
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "overmind-notebook-"));
  directories.push(path);
  return path;
}
const notebookAt = (cwd: string) => new CausalNotebook(cwd, join(cwd, "state"));
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Causal Notebook durable storage", () => {
  test("CRUD preserves structured evidence, IDs and timestamps across new instances", async () => {
    const cwd = await directory();
    const notebook = notebookAt(cwd);
    const entry = await notebook.write(supervisor, observation);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    const reloaded = notebookAt(cwd);
    expect(await reloaded.read(supervisor)).toEqual([entry]);
    expect(entry.evidence).toEqual(observation.evidence);
    const updated = await reloaded.update(supervisor, entry.id, {
      ...observation,
      impact: "Recovered",
    });
    expect(updated).toMatchObject({
      id: entry.id,
      timestamp: entry.timestamp,
      impact: "Recovered",
    });
    expect(
      await reloaded.read(supervisor, {
        keyword: "recovered",
        workspace_id: "project",
        anti_pattern: "waiting",
      }),
    ).toHaveLength(1);
    expect(await reloaded.read(supervisor, { workspace_id: "other-project" })).toEqual([]);
    expect(await reloaded.read(supervisor, { anti_pattern: "other-pattern" })).toEqual([]);
    expect(await reloaded.delete(supervisor, entry.id)).toBe(true);
    expect(await reloaded.delete(supervisor, entry.id)).toBe(false);
    expect(await notebookAt(cwd).read(supervisor)).toEqual([]);
  });
  test("serializes concurrent writers and deduplicates a live/turn-boundary alert", async () => {
    const cwd = await directory();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        notebookAt(cwd).write(supervisor, {
          ...observation,
          session_id: `session-${index}`,
        }),
      ),
    );
    const notebook = notebookAt(cwd);
    const first = await notebook.write(supervisor, { ...observation, alert_id: "one-alert" });
    const second = await notebook.write(supervisor, {
      ...observation,
      alert_id: "one-alert",
      impact: "Final evidence",
    });
    expect(second.id).toBe(first.id);
    await notebook.write(
      supervisor,
      {
        ...observation,
        alert_id: "one-alert",
        suspected_mechanism: "unconfirmed",
        protocol_candidate: false,
      },
      true,
    );
    expect((await notebook.read(supervisor)).find((entry) => entry.id === first.id)).toMatchObject({
      suspected_mechanism: "quota exhaustion",
      protocol_candidate: true,
    });
    expect(await notebook.read(supervisor)).toHaveLength(9);
  });
  test("rejects invalid payloads and preserves corrupted notebooks", async () => {
    const notebook = notebookAt(await directory());
    expect(() => notebook.write(supervisor, { ...observation, evidence: [] })).toThrow();
    await notebook.write(supervisor, observation);
    await writeFile(notebook.path, "manual invalid edit");
    await expect(notebook.write(supervisor, observation)).rejects.toThrow(
      "existing contents were preserved",
    );
    expect(await readFile(notebook.path, "utf8")).toBe("manual invalid edit");
  });
  test("keeps the notebook out of the project and moves a legacy project notebook", async () => {
    const cwd = await directory();
    const legacy = join(cwd, ".overmind", "notebook.md");
    const entry = { ...observation, id: randomUUID(), timestamp: new Date().toISOString() };
    await mkdir(join(cwd, ".overmind"));
    await writeFile(
      legacy,
      `# Overmind Causal Notebook\n\n\`\`\`json\n${JSON.stringify({ version: 1, entries: [entry] })}\n\`\`\`\n`,
    );
    const notebook = notebookAt(cwd);
    expect(notebook.path.startsWith(join(cwd, "state"))).toBe(true);
    expect(await notebook.readForOwner()).toEqual([entry]);
    await notebook.write(supervisor, { ...observation, session_id: "session-2" });
    await expect(readFile(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await notebookAt(cwd).read(supervisor)).toHaveLength(2);
  });
  test.each(["overmind-lead", "overmind-peer", "codex", "codex-supervisor"])(
    "denies every operation to %s",
    async (provider) => {
      const notebook = notebookAt(await directory());
      const actor = { provider, agentId: "other" };
      await expect(notebook.read(actor)).rejects.toThrow("OVERMIND_NOTEBOOK_DENIED");
      expect(() => notebook.write(actor, observation)).toThrow("OVERMIND_NOTEBOOK_DENIED");
      expect(() => notebook.update(actor, "id", observation)).toThrow("OVERMIND_NOTEBOOK_DENIED");
      expect(() => notebook.delete(actor, "id")).toThrow("OVERMIND_NOTEBOOK_DENIED");
      const engine = new SkillFilteringEngine({
        lead: { allowed_skills: ["*"], denied_skills: [] },
        peer: { allowed_skills: ["*"], denied_skills: [] },
      });
      for (const tool of NOTEBOOK_TOOLS) {
        expect(engine.isAllowed("supervisor", tool)).toBe(true);
        expect(engine.isAllowed("lead", tool)).toBe(false);
        expect(engine.isAllowed("peer", tool)).toBe(false);
      }
    },
  );
  test.each([
    "# Workspace protocol\n\nPreserve contracts.\n",
    "# Protocol without final newline",
    null,
  ])(
    "generates an applicable candidate only for repeated causal entries across sessions (%s)",
    async (original) => {
      const cwd = await directory();
      const notebook = notebookAt(cwd);
      const actions = createNotebookActions(async () => cwd, join(cwd, "state"));
      const propose = () =>
        actions.get("causal_notebook_propose_protocol")!(supervisor, {
          workspace_id: "project",
          anti_pattern: "waiting",
        });
      await notebook.write(supervisor, observation);
      await notebook.write(supervisor, observation);
      expect(await propose()).toMatchObject({ proposed: false });
      await notebook.write(supervisor, {
        ...observation,
        session_id: "session-2",
        suspected_mechanism: "different cause",
      });
      expect(await propose()).toMatchObject({ proposed: false });
      await notebook.write(supervisor, { ...observation, session_id: "session-3" });
      if (original !== null) await writeFile(join(cwd, "WORKSPACE_PROTOCOL.md"), original);
      const result = (await propose()) as { proposed: boolean; patch: string };
      expect(result.proposed).toBe(true);
      const patchPath = join(cwd, "candidate.patch");
      await writeFile(patchPath, result.patch);
      execFileSync("git", ["apply", "--check", "--no-index", patchPath], { cwd });
      if (original !== null)
        expect(await readFile(join(cwd, "WORKSPACE_PROTOCOL.md"), "utf8")).toBe(original);
      else
        await expect(readFile(join(cwd, "WORKSPACE_PROTOCOL.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );
});

test("real MCP actions persist through service/session reset and reject forged roles", async () => {
  const cwd = await directory();
  const state = await directory();
  let provider = "overmind-supervisor";
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { id, provider, archivedAt: null } }),
      }),
    },
    workspaces: {
      ref: (id: string) => ({
        refresh: async () => (id === "project" ? { projectRootPath: cwd } : null),
      }),
    },
  } as unknown as PaseoApi;
  const coordinator = new Coordinator({
    paseo: api,
    seats: new SeatStore(join(state, "seats.json")),
    relay: new Relay(),
    tickets: new CreationTickets(),
    detections: new DetectionLog(join(state, "detections.jsonl")),
    repetition: new RepetitionTracker(new SeatStore(join(state, "seats.json"))),
    intents: new IntentStore(join(state, "intent.json")),
    modelFor: async () => "model",
  });
  const accessPath = join(state, "capabilities.json");
  let service = await CapabilityService.open(accessPath, api, coordinator);
  const stale = { overmind_notebook: { type: "http" as const, url: "http://127.0.0.1:1/x" } };
  const { mcpServers, capabilityId } = await service.prepare({
    provider: "overmind-supervisor",
    cwd,
    mcpServers: stale,
  });
  const notebookServer = mcpServers.overmind_notebook as {
    url: string;
    headers: Record<string, string>;
  };
  expect(mcpServers.overmind).toBeDefined();
  expect((await fetch(notebookServer.url)).status).toBe(403);
  await service.bind(capabilityId!, supervisor);
  await expect(
    service.bind(capabilityId!, { ...supervisor, agentId: "another-supervisor" }),
  ).rejects.toThrow("invalid session binding");
  const lead = await service.prepare({ provider: "overmind-lead", cwd, mcpServers: stale });
  expect(lead.mcpServers.overmind_notebook).toBeUndefined();
  expect(lead.mcpServers.overmind).toBeDefined();
  const peer = await service.prepare({ provider: "overmind-peer", cwd, mcpServers: stale });
  expect(peer).toEqual({ mcpServers: {}, capabilityId: null });
  let client = new Client({ name: "notebook-integration", version: "1" });
  const connect = (server: { url: string; headers: Record<string, string> }) =>
    client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
      }),
    );
  try {
    await connect(notebookServer);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
      [...NOTEBOOK_TOOLS].sort(),
    );
    const write = await client.callTool({ name: "causal_notebook_write", arguments: observation });
    expect(write.isError).not.toBe(true);
    await client.close();
    await service.close();
    service = await CapabilityService.open(accessPath, api, coordinator);
    client = new Client({ name: "notebook-integration-reset", version: "1" });
    await connect(notebookServer);
    const read = await client.callTool({
      name: "causal_notebook_read",
      arguments: { workspace_id: "project" },
    });
    expect(read.isError).not.toBe(true);
    expect(JSON.parse((read.content as { text: string }[])[0].text)).toHaveLength(1);
    const invalid = await client.callTool({
      name: "causal_notebook_read",
      arguments: { workspace_id: "missing" },
    });
    expect(invalid.isError).toBe(true);
    await client.close();
    client = new Client({ name: "coordination-integration", version: "1" });
    await connect(mcpServers.overmind as { url: string; headers: Record<string, string> });
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["create_agent", "overmind_task_review"]));
    expect(tools).toContain("create_supervisor_wake");
    expect(tools).not.toContain("contract_lock");
    await expect(
      service.bind(capabilityId!, { provider: "overmind-lead", agentId: "lead" }),
    ).rejects.toThrow("DENIED");
    const forgedWake = await client.callTool({
      name: "create_supervisor_wake",
      arguments: { cron: "* * * * *", agentId: "lead", maxRuns: 2 },
    });
    expect(forgedWake.isError).toBe(true);
    await client.close();
    for (provider of ["overmind-lead", "overmind-peer"]) {
      client = new Client({ name: "forged-role", version: "1" });
      await expect(connect(notebookServer)).rejects.toThrow();
    }
  } finally {
    await client.close();
    await service.close();
  }
});

test.each(["regex", "semantic"] as const)(
  "%s alert captures scores and published evidence at a turn boundary",
  async (tier) => {
    const cwd = await directory();
    const source = {
      id: "lead",
      provider: "overmind-lead",
      workspaceId: "project",
      parentAgentId: "supervisor",
      cwd,
      title: "Lead",
    };
    const api = {
      agents: {
        list: async () => ({ entries: [] }),
        ref: (id: string) => ({
          refresh: async () => ({
            agent: {
              id,
              provider: id === "supervisor" ? "overmind-supervisor" : "overmind-lead",
              archivedAt: null,
              persistence: { sessionId: "native-session" },
              labels: { "paseo.parent-agent-id": id === "lead" ? "supervisor" : "" },
            },
          }),
          timeline: {
            append: vi.fn(),
            refetch: async () => ({
              entries: [
                { item: { type: "user_message", text: "Review task" } },
                { item: { type: "reasoning", text: "Provider-published reasoning summary" } },
                {
                  item: {
                    type: "tool_call",
                    callId: "tool-1",
                    name: "git diff",
                    status: "completed",
                    detail: { output: "No diff" },
                  },
                },
                { item: { type: "assistant_message", text: "I'm blocked: repeated waiting" } },
              ],
            }),
          },
        }),
      },
      workspaces: { ref: () => ({ refresh: async () => ({ projectRootPath: cwd }) }) },
    } as unknown as PaseoApi;
    const monitor = new DetectionMonitor();
    monitor.on(OVERMIND_EVENT_ALERT, (...args) =>
      captureNotebookAlert(...args, join(cwd, "state")),
    );
    try {
      await monitor.onTurnEnded(
        source,
        "turn-1",
        { kind: "completed" },
        api,
        overmindSettings.schema.parse({ detection: { mode: tier } }),
      );
      const entries = await notebookAt(cwd).read(supervisor);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ session_id: "native-session", protocol_candidate: false });
      expect(entries[0].evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "sensor",
            metadata: expect.objectContaining({ tier: tier === "regex" ? 1 : 2, score: 1 }),
          }),
          expect.objectContaining({ kind: "reasoning_summary" }),
          expect.objectContaining({ kind: "tool_output" }),
        ]),
      );
      expect(monitor.status().alerts).toHaveLength(1);
    } finally {
      monitor.dispose();
    }
  },
);
