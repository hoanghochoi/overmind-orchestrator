import type { RpcOutput } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginHookAgent,
  PluginServerContext,
  PluginServerContribution,
} from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ROLE_SKILLS,
  OvermindRuntime,
  SkillFilteringEngine,
  rolePrompt,
  type OvermindRole,
} from "../shared/index.js";
import { overmindSettings, profileBinding } from "../shared/settings.js";
import {
  controlStatus,
  embeddingModels,
  projectHistory,
  readImage,
  reviewTask,
  seatLabels,
  syncProviders,
  testEmbedding,
  testJev,
} from "../shared/control.js";
import { roleForProvider } from "../shared/providers.js";
import { reviewableTurn } from "../shared/tasks.js";
import { DriverRegistry } from "./adapters/index.js";
import { DetectionMonitor } from "./detection.js";
import { DetectionLog } from "./detection-log.js";
import { RepetitionTracker } from "./repetition.js";
import { IntentStore } from "./intent-store.js";
import {
  builtinEmbeddingStatus,
  checkEmbedding,
  configureEmbeddingRuntime,
  disposeEmbedding,
  listEmbeddingModels,
  prepareBuiltinEmbedding,
} from "./embedding.js";
import { checkJev } from "./jev.js";
import { imageDataUri } from "./image.js";
import {
  enforcedProviderOptions,
  profileStatuses,
  publishProfiles,
  resolveDriver,
  seatProfiles,
} from "./providers.js";
import {
  CAPABILITY_ENV,
  COORDINATION_SERVER,
  CapabilityService,
  NOTEBOOK_SERVER,
} from "./capabilities.js";
import { COORDINATION_TOOLS, Coordinator, toolsForRole } from "./coordination.js";
import { CausalNotebook, NOTEBOOK_TOOLS } from "./modules/causal_notebook.js";
import { captureNotebookAlert } from "./notebook-capture.js";
import { OVERMIND_EVENT_ALERT } from "./hybrid_sensor.js";
import { CREATION_TICKET_ENV, CreationTickets, loadSeat, type Seat } from "./policy.js";
import { Relay } from "./relay.js";
import { projectRoot, readTasks, recordTask } from "./project-history.js";
import { REVIEW_STATUSES } from "./review.js";
import { SeatStore } from "./seat-store.js";

const ROLE_KEY = "overmindRole";
const NATIVE_SUBAGENT_KEY = "multi_agent_version";
const PREAPPROVAL_DRIVERS = new Set(["codex", "claude", "opencode"]);

function assertRoleIdentity(config: Parameters<typeof readRole>[0]): void {
  const aliasRole = roleForProvider(config.provider);
  const persisted = config.featureValues?.overmindRole;
  if (aliasRole && persisted && persisted !== aliasRole)
    throw new Error("OVERMIND_ROLE_DENIED: provider and requested role disagree");
}
function readRole(config: {
  provider: string;
  providerOptions?: Record<string, unknown>;
  featureValues?: Record<string, unknown>;
}): OvermindRole | null {
  const value =
    roleForProvider(config.provider) ??
    config.providerOptions?.[ROLE_KEY] ??
    config.featureValues?.[ROLE_KEY];
  return value === "supervisor" || value === "lead" || value === "peer" ? value : null;
}
function readRoleFromEnv(env: Record<string, string> | undefined): OvermindRole | null {
  const value = env?.OVERMIND_ROLE;
  return value === "supervisor" || value === "lead" || value === "peer" ? value : null;
}
function roleHomeOptions(
  env: Record<string, string> | undefined,
  featureValues?: Record<string, unknown>,
): { homeDirectory?: string } {
  const featureHome = featureValues?.overmindHomeRoot;
  if (typeof featureHome === "string") return { homeDirectory: featureHome };
  const envHome = env?.OVERMIND_HOME_ROOT;
  return typeof envHome === "string" ? { homeDirectory: envHome } : {};
}
function adapterForProvider(provider: string) {
  return DriverRegistry.getAdapter(provider.split("/", 1)[0] ?? provider);
}
/** Preapprove the plugin's own tools; the daemon checks they ship in the same request. */
function coordinationToolPolicy(role: OvermindRole, driver: string) {
  if (role === "peer" || !PREAPPROVAL_DRIVERS.has(driver)) return {};
  return {
    toolPolicy: {
      preapproved: [
        ...toolsForRole(role).map((tool) => ({
          kind: "mcp" as const,
          server: COORDINATION_SERVER,
          tool,
        })),
        ...(role === "supervisor"
          ? NOTEBOOK_TOOLS.map((tool) => ({ kind: "mcp" as const, server: NOTEBOOK_SERVER, tool }))
          : []),
      ],
    },
  };
}
function roleSkillEnv(role: OvermindRole): Record<string, string> {
  const overlay = new SkillFilteringEngine(DEFAULT_ROLE_SKILLS).overlay(role);
  return {
    OVERMIND_NATIVE_SUBAGENTS_ENABLED: "false",
    OVERMIND_SKILL_ALLOWLIST: overlay.allowed_skills.join(","),
    OVERMIND_SKILL_DENYLIST: overlay.denied_skills.join(","),
  };
}

export interface OvermindServerOptions {
  /** Plugin-owned state: seat labels and MCP capability grants. */
  stateDirectory?: string;
}

export function createContribution(options: OvermindServerOptions = {}): PluginServerContribution {
  return (server: PluginServerContext) => {
    const stateDirectory = options.stateDirectory ?? join(homedir(), ".overmind", "paseo-plugin");
    const settings = server.registerSettings(overmindSettings);
    const runtime = new OvermindRuntime({ skillMatrix: DEFAULT_ROLE_SKILLS });
    const seats = new SeatStore(join(stateDirectory, "seats.json"));
    const relay = new Relay(seats, join(stateDirectory, "relay.json"));
    const tickets = new CreationTickets();
    const detectionLog = new DetectionLog(join(stateDirectory, "detections.jsonl"));
    const repetition = new RepetitionTracker(seats);
    const monitor = new DetectionMonitor({ log: detectionLog, repetition });
    monitor.on(OVERMIND_EVENT_ALERT, (...args) => captureNotebookAlert(...args, stateDirectory));
    let disposed = false;
    let coordinator: Coordinator | undefined;
    let capabilities: Promise<CapabilityService> | undefined;
    function coordinatorFor(paseo: PaseoApi): Coordinator {
      coordinator ??= new Coordinator({
        paseo,
        seats,
        relay,
        tickets,
        detections: detectionLog,
        repetition,
        intents: new IntentStore(join(stateDirectory, "intent.json")),
        profiles: async () => seatProfiles(paseo, await currentSettings()),
      });
      return coordinator;
    }
    function capabilityService(paseo: PaseoApi): Promise<CapabilityService> {
      capabilities ??= CapabilityService.open(
        join(stateDirectory, "capabilities.json"),
        paseo,
        coordinatorFor(paseo),
      );
      void capabilities.catch(() => {
        capabilities = undefined;
      });
      return capabilities;
    }
    /** Lead and Peer creation spends a ticket issued for an authorized parent. */
    function consumeCreationTicket(
      role: OvermindRole | null,
      requested: Record<string, string> | undefined,
    ): Record<string, string> {
      const env = { ...requested };
      const ticket = env[CREATION_TICKET_ENV];
      delete env[CREATION_TICKET_ENV];
      if ((role === "lead" || role === "peer") && !tickets.consume(ticket, role))
        throw new Error(
          "OVERMIND_ROLE_DENIED: create Leads with the Supervisor's Overmind tools and Peers with their Lead's",
        );
      return env;
    }
    /** Keep a Lead or Peer task in its project, where it outlives the agent. */
    async function recordSeatTask(paseo: PaseoApi, agentId: string): Promise<void> {
      const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
      const role = agent ? roleForProvider(agent.provider) : null;
      if (!agent?.workspaceId || (role !== "lead" && role !== "peer")) return;
      await recordTask(await projectRoot(paseo, agent.workspaceId), {
        agentId: agent.id,
        title: agent.title,
        provider: agent.provider,
        model: agent.model,
        status: agent.status,
        workspaceId: agent.workspaceId,
        lastUserMessageAt: agent.lastUserMessageAt ?? null,
        labels: { ...agent.labels, ...(await seats.get(agent.id)) },
        updatedAt: new Date().toISOString(),
        archivedAt: agent.archivedAt ?? null,
      });
    }
    const seatWrites = new Map<string, Promise<void>>();
    /** Seat state the taskboard reads. Only values the runtime actually observes. */
    function writeSeat(
      paseo: PaseoApi,
      agent: PluginHookAgent,
      state: {
        status: "THINKING" | "IDLE";
        task: "IN_PROGRESS" | "READY_FOR_REVIEW";
        turnId: string | null;
        outcome: string;
      },
      before?: () => Promise<void>,
    ) {
      if (!roleForProvider(agent.provider)) return Promise.resolve();
      const write = (seatWrites.get(agent.id) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          await before?.();
          const current = (await paseo.agents.ref(agent.id).refresh())?.agent;
          // A newer turn owns the seat; this event is stale.
          if (current?.activeTurn && current.activeTurn.turnId !== state.turnId) return undefined;
          await seats.merge(agent.id, {
            "overmind.status": state.status,
            "overmind.task.status": state.task,
            "overmind.turn.id": state.turnId ?? "",
            "overmind.turn.outcome": state.outcome,
            "overmind.turn.message_at": current?.lastUserMessageAt ?? "",
            "overmind.mailbox_count":
              state.outcome === "running"
                ? ""
                : String(monitor.pendingNotices(agent.id) + relay.pending(agent.id)),
          });
          await recordSeatTask(paseo, agent.id);
          return undefined;
        })
        .catch(() => undefined);
      seatWrites.set(agent.id, write);
      void write.finally(() => {
        if (seatWrites.get(agent.id) === write) seatWrites.delete(agent.id);
      });
      return write;
    }
    /** The settings a profile seat is created from; it must name a provider and model. */
    async function configuredBinding(provider: string, role: OvermindRole) {
      const binding = profileBinding(await currentSettings(), provider);
      if (!binding?.provider || !binding.model)
        throw new Error(`Chưa cấu hình đầy đủ Overmind ${role}. Mở Overmind Command → Settings.`);
      return binding;
    }
    async function currentSettings() {
      const result = await settings.read();
      if (result.status !== "ready") throw new Error(result.error);
      return result.values;
    }
    function prepareModel(values: Awaited<ReturnType<typeof currentSettings>>) {
      if (
        !disposed &&
        values.detection.embedding.backend === "builtin" &&
        builtinEmbeddingStatus().status === "idle"
      )
        void prepareBuiltinEmbedding().catch(() => undefined);
    }
    void currentSettings()
      .then(prepareModel)
      .catch(() => undefined);
    server.handle(syncProviders, async (_input, { paseo }) => ({
      profiles: await publishProfiles(paseo, await currentSettings()),
    }));
    let reconciled: Promise<void> | undefined;
    /**
     * Plugin hooks get no host API at load, so the first event or RPC after a reload reports
     * the turns that ended while the plugin was down.
     */
    function reconcileOnce(paseo: PaseoApi): void {
      reconciled ??= Promise.all([
        capabilityService(paseo),
        relay.reconcile(paseo),
        reconcileSeats(paseo),
      ])
        .then(() => undefined)
        .catch(() => {
          reconciled = undefined;
        });
    }
    /** Seats whose turn ended unobserved still read THINKING; record the turn they finished. */
    async function reconcileSeats(paseo: PaseoApi): Promise<void> {
      const page = await paseo.agents.list({});
      const ids = page.entries.map((entry) => entry.agent.id);
      const overlays = await seats.getMany(ids);
      for (const { agent } of page.entries) {
        if (!roleForProvider(agent.provider) || agent.archivedAt) continue;
        if (agent.status === "running" || agent.activeTurn) continue;
        if (overlays[agent.id]?.["overmind.status"] !== "THINKING") continue;
        const tail = await paseo.agents
          .ref(agent.id)
          .timeline.refetch({ direction: "tail", limit: 1 });
        await writeSeat(
          paseo,
          {
            id: agent.id,
            workspaceId: agent.workspaceId ?? null,
            parentAgentId: null,
            provider: agent.provider,
            cwd: agent.cwd,
            title: agent.title,
          },
          {
            status: "IDLE",
            task: "READY_FOR_REVIEW",
            turnId: tail.entries.at(-1)?.turnId ?? null,
            outcome: "completed",
          },
        );
      }
    }
    server.handle(seatLabels, async ({ agentIds }, { paseo }) => {
      reconcileOnce(paseo);
      return { seats: await seats.getMany(agentIds) };
    });
    server.handle(readImage, async ({ path }) => ({ dataUri: await imageDataUri(path) }));
    server.handle(reviewTask, async ({ agentId, turnId, decision, evidence }, { paseo }) => {
      await seatWrites.get(agentId);
      const target: Seat | null = await loadSeat(paseo, seats, agentId);
      if (!target || target.archivedAt || !target.role || reviewableTurn(target) !== turnId)
        throw new Error(
          "Task changed or its turn is still running. Refresh and review the completed turn again.",
        );
      const labels = {
        "overmind.task.status": REVIEW_STATUSES.get(decision)!,
        "overmind.review.turn_id": turnId,
        "overmind.review.message_at": target.lastUserMessageAt ?? "",
        "overmind.review.decision": decision,
        "overmind.review.evidence": evidence.trim(),
        "overmind.review.at": new Date().toISOString(),
        "overmind.review.reviewer_kind": "human",
        "overmind.review.reviewer_id": "",
        "overmind.review.agreement_id": "",
        "overmind.review.scope": "",
        "overmind.review.checks": "",
        "overmind.review.requested_change": "",
        "overmind.review.human_context": "",
      };
      await seats.merge(agentId, labels);
      await recordSeatTask(paseo, agentId).catch(() => undefined);
      return { agentId, labels };
    });
    server.handle(controlStatus, async (_input, { paseo }) => {
      reconcileOnce(paseo);
      const values = await currentSettings();
      await configureEmbeddingRuntime(paseo);
      prepareModel(values);
      return {
        profiles: await profileStatuses(paseo, values),
        mode: values.detection.mode,
        embeddingModel:
          values.detection.embedding.backend === "builtin"
            ? "all-MiniLM-L6-v2 · int8 (CPU)"
            : values.detection.embedding.model,
        builtinModel: builtinEmbeddingStatus(),
        jevEnabled: values.jev.enabled,
        ...monitor.status(),
      };
    });
    server.handle(projectHistory, async (_input, { paseo }) => {
      const projects: RpcOutput<typeof projectHistory>["projects"] = [];
      const errors: string[] = [];
      for (const project of (await paseo.projects.list()).projects) {
        const rootPath = project.projectRootPath;
        try {
          const [tasks, notebook] = await Promise.all([
            readTasks(rootPath),
            new CausalNotebook(rootPath, stateDirectory).readForOwner(),
          ]);
          if (!tasks.length && !notebook.length) continue;
          projects.push({
            name: project.projectDisplayName,
            rootPath,
            tasks,
            notebook: notebook
              .map((entry) => ({
                id: entry.id,
                timestamp: entry.timestamp,
                workspaceId: entry.workspace_id,
                observation: entry.observation,
                suspectedMechanism: entry.suspected_mechanism,
                impact: entry.impact,
                recommendation: entry.recommendation,
                antiPattern: entry.anti_pattern ?? null,
                protocolCandidate: entry.protocol_candidate,
                evidenceCount: entry.evidence.length,
              }))
              .sort((left, right) => right.timestamp.localeCompare(left.timestamp)),
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          errors.push(`${project.projectDisplayName}: ${reason}`);
        }
      }
      return { projects, errors };
    });
    server.handle(testJev, (input) => checkJev(input));
    server.handle(testEmbedding, async (input, { paseo }) => {
      await configureEmbeddingRuntime(paseo);
      return checkEmbedding(input);
    });
    server.handle(embeddingModels, async ({ baseUrl }) => listEmbeddingModels(baseUrl));
    const cleanups = [
      settings.subscribe((state) => {
        if (state.status === "ready") prepareModel(state.values);
      }),
      server.before("agent.create", async ({ request }, { paseo }) => {
        const role = readRole(request.config);
        if (!role) return request;
        const aliasRole = roleForProvider(request.config.provider);
        assertRoleIdentity(request.config);
        const env = consumeCreationTicket(aliasRole, request.env);
        const binding = aliasRole ? await configuredBinding(request.config.provider, role) : null;
        const source = binding?.provider ?? request.config.provider;
        const driver = await resolveDriver(paseo, source);
        const roleEnv = await adapterForProvider(driver).buildSpawnEnv(role, {
          cwd: request.config.cwd,
          ...roleHomeOptions(request.env, request.config.featureValues),
        });
        const providerOptions = enforcedProviderOptions(role, driver, {
          ...request.config.providerOptions,
        });
        delete providerOptions[ROLE_KEY];
        delete providerOptions[NATIVE_SUBAGENT_KEY];
        const prepared = aliasRole
          ? await (await capabilityService(paseo)).prepare(request.config)
          : { mcpServers: request.config.mcpServers, capabilityId: null };
        return {
          ...request,
          env: {
            ...env,
            ...roleEnv,
            ...(prepared.capabilityId ? { [CAPABILITY_ENV]: prepared.capabilityId } : {}),
          },
          config: {
            ...request.config,
            ...(binding
              ? {
                  model: binding.model,
                  // An effort the creator asked for outranks the profile default.
                  thinkingOptionId:
                    request.config.thinkingOptionId || binding.thinkingOptionId || undefined,
                  ...(binding.modeId ? { modeId: binding.modeId } : {}),
                }
              : {}),
            providerOptions: Object.keys(providerOptions).length ? providerOptions : undefined,
            mcpServers: prepared.mcpServers,
            ...(aliasRole ? coordinationToolPolicy(role, driver) : {}),
            featureValues: {
              ...request.config.featureValues,
              ...(request.env?.OVERMIND_HOME_ROOT
                ? { overmindHomeRoot: request.env.OVERMIND_HOME_ROOT }
                : {}),
              [ROLE_KEY]: role,
              overmindDriver: driver,
              [NATIVE_SUBAGENT_KEY]: role === "peer" ? "disabled" : "paseo",
            },
            systemPrompt: request.config.systemPrompt
              ? `${request.config.systemPrompt}\n\n${rolePrompt(role)}`
              : rolePrompt(role),
          },
        };
      }),
      server.before("agent.session_open", async ({ request }, { paseo }) => {
        const aliasRole = roleForProvider(request.provider);
        const role = aliasRole ?? readRoleFromEnv(request.env);
        if (!role) return request;
        // A removed Peer kind's profile still resolves through its `extends`.
        const source = aliasRole
          ? (profileBinding(await currentSettings(), request.provider)?.provider ??
            request.provider)
          : request.provider;
        const driver = await resolveDriver(paseo, source);
        const env = await adapterForProvider(driver).buildSpawnEnv(role, {
          cwd: request.cwd,
          ...roleHomeOptions(request.env),
        });
        const capability = request.env[CAPABILITY_ENV];
        // Resumed seats reach the persisted endpoint, so it must listen before they run.
        const service = aliasRole === "peer" || !aliasRole ? null : await capabilityService(paseo);
        // A new seat binds its grant once; a resumed seat keeps the persisted binding.
        if (service && capability)
          await service.bind(capability, { provider: request.provider, agentId: request.agentId });
        // COMPAT(supervisorWakeTools): 0.14 supplies tools here; 0.13.2 uses the MCP grant on new seats.
        // Remove when the plugin's minimum Paseo version reaches 0.14 (after 2027-02-04).
        const tools =
          aliasRole === "supervisor" && "tools" in request && Array.isArray(request.tools)
            ? [
                ...request.tools,
                {
                  name: "create_supervisor_wake",
                  description: COORDINATION_TOOLS.create_supervisor_wake.description,
                  input: COORDINATION_TOOLS.create_supervisor_wake.schema,
                  execute: async (input: unknown) => ({
                    text: JSON.stringify(
                      await coordinatorFor(paseo).call(
                        request.agentId,
                        "create_supervisor_wake",
                        input,
                      ),
                    ),
                  }),
                },
              ]
            : undefined;
        return {
          ...request,
          ...(tools ? { tools } : {}),
          env: { ...request.env, ...env, ...roleSkillEnv(role) },
        };
      }),
      server.on("agent.turn_started", ({ agent, turnId }, { paseo }) => {
        reconcileOnce(paseo);
        runtime.beginTurn(agent.id);
        // After a plugin reload, live seats find their endpoint again at the next turn.
        const role = roleForProvider(agent.provider);
        if (role === "supervisor" || role === "lead")
          void capabilityService(paseo).catch(() => undefined);
        void writeSeat(paseo, agent, {
          status: "THINKING",
          task: "IN_PROGRESS",
          turnId,
          outcome: "running",
        });
        void currentSettings()
          .then((values) => monitor.onTurnStarted(agent, turnId, paseo, values))
          .catch(() => undefined);
      }),
      server.on("agent.turn_ended", async ({ agent, turnId, outcome }, { paseo }) => {
        runtime.endTurn(agent.id);
        await writeSeat(
          paseo,
          agent,
          {
            status: "IDLE",
            turnId,
            outcome: outcome.kind,
            // A failed or canceled turn leaves the seat's work unfinished.
            task: outcome.kind === "completed" ? "READY_FOR_REVIEW" : "IN_PROGRESS",
          },
          async () => monitor.onTurnEnded(agent, turnId, outcome, paseo, await currentSettings()),
        );
        await relay.onTurnEnded(paseo, agent, outcome).catch(() => undefined);
      }),
      server.on("agent.archived", async ({ agent }, { paseo }) => {
        await seatWrites.get(agent.id);
        await recordSeatTask(paseo, agent.id).catch(() => undefined);
        await relay.onArchived(paseo, agent).catch(() => undefined);
      }),
      server.on("agent.closed", ({ agent }) => {
        runtime.close(agent.id);
        monitor.close(agent.id);
      }),
    ];
    return async () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      await Promise.allSettled(seatWrites.values());
      monitor.dispose();
      await monitor.drain();
      void disposeEmbedding();
      runtime.dispose();
      await (await capabilities?.catch(() => undefined))?.close();
      await seats.flush();
    };
  };
}

export { COORDINATION_TOOLS };
export default createContribution();
