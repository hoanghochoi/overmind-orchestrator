import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execCommand } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { Coordinator } from "../server/coordination.js";
import { CREATION_TICKET_ENV, CreationTickets } from "../server/policy.js";
import { Relay } from "../server/relay.js";
import { SeatStore } from "../server/seat-store.js";
import { DetectionLog } from "../server/detection-log.js";
import { RepetitionTracker } from "../server/repetition.js";
import { GREAT_NAMES, pickName } from "../server/names.js";
import { IntentStore } from "../server/intent-store.js";
import type { SeatProfile } from "../server/providers.js";

vi.mock("@getpaseo/plugin/server", () => ({ execCommand: vi.fn() }));

interface FakeAgent {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  labels: Record<string, string>;
  status: string;
  activeTurn: { turnId: string } | null;
  lastUserMessageAt: string | null;
  archivedAt: string | null;
  title: string | null;
  timeline: { type: string; text: string }[];
}

function fakePaseo(directory: string) {
  const agents = new Map<string, FakeAgent>();
  const sent: { to: string; text: string; sourceAgentId?: string }[] = [];
  const created: { workspaceId: string; options: Record<string, unknown> }[] = [];
  const workspaceTitles = new Map<string, string | null>();
  const add = (agent: Partial<FakeAgent> & { id: string; provider: string }) => {
    agents.set(agent.id, {
      cwd: directory,
      workspaceId: "ws-1",
      labels: {},
      status: "idle",
      activeTurn: null,
      lastUserMessageAt: null,
      archivedAt: null,
      title: agent.id,
      timeline: [],
      ...agent,
    });
  };
  const parent = (id: string) => ({ "paseo.parent-agent-id": id });
  const api = {
    agents: {
      list: async () => ({ entries: [...agents.values()].map((agent) => ({ agent })) }),
      ref: (id: string) => ({
        refresh: async () => (agents.has(id) ? { agent: agents.get(id)! } : null),
        send: async (text: string, options: { sourceAgentId?: string }) => {
          sent.push({ to: id, text, sourceAgentId: options.sourceAgentId });
        },
        archive: async () => {
          agents.get(id)!.archivedAt = new Date().toISOString();
          return { archivedAt: agents.get(id)!.archivedAt! };
        },
        timeline: {
          refetch: async () => ({
            entries: (agents.get(id)?.timeline ?? []).map((item) => ({ item })),
          }),
        },
      }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        setTitle: async (title: string | null) => {
          workspaceTitles.set(workspaceId, title);
          return { title };
        },
        agents: {
          create: async (options: Record<string, unknown>) => {
            // The released SDK rejects a provider without a model.
            if (!/^[^/]+\/.+$/.test((options.config as { provider: string }).provider))
              throw new Error('Expected config.provider in "provider/model" format');
            created.push({ workspaceId, options });
            const id = `created-${created.length}`;
            add({
              id,
              provider: (options.config as { provider: string }).provider.split("/")[0]!,
              workspaceId,
              title: options.title as string,
              labels: { ...(options.labels as object), ...parent(options.parent as string) },
            });
            return { id };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  return { api, agents, add, parent, sent, created, workspaceTitles };
}

let directory: string;
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "overmind-coordination-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function setup() {
  const fake = fakePaseo(directory);
  const seats = new SeatStore(path.join(directory, "state", "seats.json"));
  const relay = new Relay(seats);
  const tickets = new CreationTickets();
  const detections = new DetectionLog(path.join(directory, "state", "detections.jsonl"));
  const repetition = new RepetitionTracker(seats);
  const coordinator = new Coordinator({
    paseo: fake.api,
    seats,
    relay,
    tickets,
    detections,
    repetition,
    intents: new IntentStore(path.join(directory, "state", "intent.json")),
    profiles: async () => [
      seatProfile({ role: "lead", provider: "overmind-lead", model: "lead-model" }),
      seatProfile({
        role: "peer",
        provider: "overmind-peer",
        model: "peer-model",
        efforts: ["low", "high"],
      }),
    ],
  });
  fake.add({ id: "sup", provider: "overmind-supervisor" });
  fake.add({ id: "lead", provider: "overmind-lead", labels: fake.parent("sup") });
  fake.add({ id: "peer", provider: "overmind-peer", labels: fake.parent("lead") });
  fake.add({ id: "other-lead", provider: "overmind-lead", labels: fake.parent("someone") });
  fake.add({ id: "foreign-peer", provider: "overmind-peer", labels: fake.parent("other-lead") });
  return { ...fake, seats, relay, tickets, coordinator, detections };
}

function seatProfile(
  profile: Pick<SeatProfile, "role" | "provider" | "model"> & Partial<SeatProfile>,
): SeatProfile {
  return {
    efforts: [],
    defaultEffort: null,
    source: `codex/${profile.model}`,
    ...profile,
  };
}

function hookAgent(id: string, provider: string, parentAgentId: string | null): PluginHookAgent {
  return { id, provider, cwd: directory, workspaceId: "ws-1", parentAgentId, title: id };
}

describe("Overmind coordination tools", () => {
  test("a Supervisor schedules one wake for its authenticated current agent", async () => {
    const { coordinator, created } = setup();
    vi.mocked(execCommand).mockResolvedValueOnce({
      stdout: JSON.stringify({ id: "wake-1", status: "active", nextRunAt: "2026-11-05T00:00:00Z" }),
      stderr: "",
    });
    await expect(
      coordinator.call("sup", "create_supervisor_wake", {
        cron: "0 7 * * *",
        timezone: "Asia/Bangkok",
      }),
    ).resolves.toMatchObject({
      id: "wake-1",
      target: { type: "agent", agentId: "sup" },
      maxRuns: 1,
      nextRunAt: "2026-11-05T00:00:00Z",
    });
    expect(execCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        "heartbeat",
        "create",
        "--cron",
        "0 7 * * *",
        "--timezone",
        "Asia/Bangkok",
        "--max-runs",
        "1",
        "--json",
      ]),
      expect.objectContaining({ env: expect.objectContaining({ PASEO_AGENT_ID: "sup" }) }),
    );
    expect(created).toHaveLength(0);
  });

  test.each(["lead", "peer", "missing"])("%s cannot schedule a Supervisor wake", async (id) => {
    const { coordinator } = setup();
    await expect(
      coordinator.call(id, "create_supervisor_wake", { cron: "* * * * *" }),
    ).rejects.toThrow("OVERMIND_ROLE_DENIED");
    expect(execCommand).not.toHaveBeenCalled();
  });

  test.each([
    { agentId: "other-supervisor" },
    { target: { type: "agent", agentId: "lead" } },
    { target: { type: "new-agent", config: { provider: "overmind-lead" } } },
    { maxRuns: 2 },
    { maxRuns: null },
    { provider: "overmind-lead" },
    { model: "different-model" },
    { prompt: "Create another Lead" },
    { serverId: "other-host" },
    { cron: "* * * * * & whoami" },
    { timezone: "UTC%PATH%" },
  ])("rejects wake overrides and shell text: %j", async (override) => {
    const { coordinator } = setup();
    await expect(
      coordinator.call("sup", "create_supervisor_wake", { cron: "* * * * *", ...override }),
    ).rejects.toThrow();
    expect(execCommand).not.toHaveBeenCalled();
  });

  test("rechecks the live Supervisor role and archive state before a wake", async () => {
    const { coordinator, agents } = setup();
    const sup = agents.get("sup")!;
    sup.archivedAt = new Date().toISOString();
    await expect(
      coordinator.call("sup", "create_supervisor_wake", { cron: "* * * * *" }),
    ).rejects.toThrow("OVERMIND_ROLE_DENIED");
    sup.archivedAt = null;
    sup.provider = "overmind-lead";
    await expect(
      coordinator.call("sup", "create_supervisor_wake", { cron: "* * * * *" }),
    ).rejects.toThrow("OVERMIND_ROLE_DENIED");
    expect(execCommand).not.toHaveBeenCalled();
  });

  test("surfaces a failed wake creation without reporting success", async () => {
    const { coordinator } = setup();
    vi.mocked(execCommand).mockRejectedValueOnce(new Error("Invalid cron expression"));
    await expect(
      coordinator.call("sup", "create_supervisor_wake", { cron: "99 * * * *" }),
    ).rejects.toThrow("Invalid cron expression");
  });

  test("a Supervisor creates an attached Lead with a one-time ticket", async () => {
    const { coordinator, created, tickets } = setup();
    const result = await coordinator.call("sup", "create_agent", {
      prompt: "Plan the release",
      task: "Lên kế hoạch release",
      workspaceId: "ws-2",
    });
    expect(result).toMatchObject({ role: "lead", workspaceId: "ws-2" });
    const options = created[0]!.options as { env: Record<string, string>; parent: string };
    expect(created[0]).toMatchObject({
      workspaceId: "ws-2",
      options: { config: { provider: "overmind-lead/lead-model" }, parent: "sup" },
    });
    expect(tickets.consume(options.env[CREATION_TICKET_ENV], "peer")).toBe(false);
    await expect(
      coordinator.call("sup", "create_agent", { prompt: "missing workspace", task: "x" }),
    ).rejects.toThrow("needs the target workspaceId");
  });

  test("children are titled '<Name> - <Role> - <task>' with distinct names", async () => {
    const { coordinator, agents, workspaceTitles } = setup();
    const lead = (await coordinator.call("sup", "create_agent", {
      prompt: "Build the garden scene",
      task: "Cảnh khu vườn",
      workspaceId: "ws-2",
    })) as { agentId: string };
    const leadTitle = agents.get(lead.agentId)!.title!;
    expect(leadTitle).toMatch(/^\w+ - Lead - Cảnh khu vườn$/);
    expect(GREAT_NAMES).toContain(leadTitle.split(" - ")[0]);
    expect(workspaceTitles.get("ws-2")).toBe(leadTitle);
    const peer = (await coordinator.call(lead.agentId, "create_agent", {
      prompt: "Draw trees",
      task: "Tạo ảnh cây cối",
    })) as { agentId: string };
    const peerTitle = agents.get(peer.agentId)!.title!;
    expect(peerTitle).toMatch(/^\w+ - Peer - Tạo ảnh cây cối$/);
    expect(peerTitle.split(" - ")[0]).not.toBe(leadTitle.split(" - ")[0]);
    // Peers share the Lead's workspace and leave its title alone.
    expect(workspaceTitles.get("ws-2")).toBe(leadTitle);
    await coordinator.call("sup", "send_agent_prompt", {
      agentId: lead.agentId,
      prompt: "Now the river",
      task: "Cảnh dòng sông",
    });
    expect(workspaceTitles.get("ws-2")).toBe(
      `${leadTitle.split(" - ")[0]} - Lead - Cảnh dòng sông`,
    );
  });

  test("a Lead picks an effort the Peer's model offers", async () => {
    const { coordinator, created } = setup();
    await coordinator.call("lead", "create_agent", {
      prompt: "Draw trees",
      task: "Tạo ảnh cây",
      effort: "high",
    });
    expect(created.at(-1)!.options).toMatchObject({
      config: { provider: "overmind-peer/peer-model", thinkingOptionId: "high" },
    });
    await expect(
      coordinator.call("lead", "create_agent", { prompt: "x", task: "x", effort: "xhigh" }),
    ).rejects.toThrow("effort xhigh is not offered by peer");
    await expect(
      coordinator.call("lead", "create_agent", { prompt: "x", task: "x", kind: "image" }),
    ).rejects.toThrow();
  });

  test("the name pool repeats only once every name is taken", () => {
    expect(GREAT_NAMES).toHaveLength(20);
    expect(pickName(new Set(GREAT_NAMES.slice(1)), () => 0.99)).toBe(GREAT_NAMES[0]);
    expect(GREAT_NAMES).toContain(pickName(new Set(GREAT_NAMES)));
  });

  test("a Lead reaches only its own Peers and a Peer has no tools", async () => {
    const { coordinator, sent } = setup();
    await coordinator.call("lead", "send_agent_prompt", { agentId: "peer", prompt: "Review X" });
    expect(sent).toEqual([{ to: "peer", text: "Review X", sourceAgentId: "lead" }]);
    await expect(
      coordinator.call("lead", "send_agent_prompt", { agentId: "foreign-peer", prompt: "x" }),
    ).rejects.toThrow("OVERMIND_ROLE_DENIED");
    await expect(
      coordinator.call("lead", "send_agent_prompt", { agentId: "other-lead", prompt: "x" }),
    ).rejects.toThrow("OVERMIND_ROLE_DENIED");
    await expect(coordinator.call("peer", "list_agents", {})).rejects.toThrow(
      "OVERMIND_ROLE_DENIED",
    );
    await expect(
      coordinator.call("sup", "archive_agent", { agentId: "other-lead" }),
    ).rejects.toThrow("OVERMIND_ROLE_DENIED");
    await expect(coordinator.call("lead", "overmind_task_review", {})).rejects.toThrow(
      "outside the lead role",
    );
  });

  test("Peer test generation needs the Lead's current contract lock", async () => {
    const { coordinator, seats } = setup();
    const brief = { agentId: "peer", prompt: "Write tests for the login API" };
    await expect(coordinator.call("lead", "send_agent_prompt", brief)).rejects.toThrow(
      "OVERMIND_CONTRACT_DENIED",
    );
    await writeFile(path.join(directory, "schema.sql"), "create table users();");
    await writeFile(path.join(directory, "api.yaml"), "openapi: 3.1.0");
    await coordinator.call("lead", "contract_lock", {
      action: "lock",
      schemaPath: "schema.sql",
      apiContractPath: "api.yaml",
    });
    await coordinator.call("lead", "send_agent_prompt", brief);
    expect((await seats.get("peer"))["overmind.task.kind"]).toBe("test-generation");
    await writeFile(path.join(directory, "api.yaml"), "openapi: 3.1.1");
    await expect(coordinator.call("lead", "send_agent_prompt", brief)).rejects.toThrow(
      "contract artifacts changed",
    );
    await expect(
      coordinator.call("lead", "contract_lock", {
        action: "lock",
        schemaPath: "../outside.sql",
        apiContractPath: "api.yaml",
      }),
    ).rejects.toThrow("OVERMIND_CONTRACT_DENIED");
  });

  test("Supervisor review binds the agreement, the completed turn and every criterion", async () => {
    const { coordinator, agents, seats } = setup();
    agents.get("sup")!.timeline = [{ type: "user_message", text: "Ship login with 2FA" }];
    await seats.merge("lead", {
      "overmind.turn.id": "turn-1",
      "overmind.turn.outcome": "completed",
    });
    await expect(
      coordinator.call("sup", "overmind_task_review", {
        action: "agreement",
        agentId: "lead",
        scope: "Login",
        acceptanceCriteria: ["2FA works"],
        humanQuotes: ["invented quote"],
      }),
    ).rejects.toThrow("cite actual human messages");
    const { agreement } = (await coordinator.call("sup", "overmind_task_review", {
      action: "agreement",
      agentId: "lead",
      scope: "Login",
      acceptanceCriteria: ["2FA works"],
      humanQuotes: ["login with 2FA"],
    })) as { agreement: { id: string } };
    const review = {
      action: "review",
      agentId: "lead",
      turnId: "turn-1",
      agreementId: agreement.id,
      decision: "accepted",
      scope: "within_agreement",
      evidence: "Ran the 2FA suite",
    };
    await expect(coordinator.call("sup", "overmind_task_review", review)).rejects.toThrow(
      "evidence for every agreed criterion",
    );
    await coordinator.call("sup", "overmind_task_review", {
      ...review,
      checks: [{ criterion: "2FA works", evidence: "suite passed" }],
    });
    expect(await seats.get("lead")).toMatchObject({
      "overmind.task.status": "DONE",
      "overmind.review.reviewer_kind": "supervisor",
    });
    agents.get("lead")!.activeTurn = { turnId: "turn-2" };
    await expect(
      coordinator.call("sup", "overmind_task_review", {
        ...review,
        checks: [{ criterion: "2FA works", evidence: "suite passed" }],
      }),
    ).rejects.toThrow("OVERMIND_REVIEW_CONFLICT");
  });
});

describe("Overmind redirect after repetition", () => {
  test("a stalled seat only accepts a prompt that states a new approach", async () => {
    const { coordinator, seats, sent } = setup();
    await seats.merge("peer", {
      "overmind.repeat.escalated": "repeated-local-patch",
      "overmind.repeat.repeated-local-patch": "3",
    });
    await expect(
      coordinator.call("lead", "send_agent_prompt", { agentId: "peer", prompt: "Try again" }),
    ).rejects.toThrow("OVERMIND_REDIRECT_REQUIRED");
    expect(sent).toEqual([]);
    await coordinator.call("lead", "send_agent_prompt", {
      agentId: "peer",
      prompt: "Review the index design",
      newApproach: "Stop patching the migration; compare the index against the query plan first.",
    });
    expect(sent[0]!.text).toContain("New approach (replaces the one that kept failing)");
    expect(await seats.get("peer")).toEqual({});
  });
});

describe("Overmind sensor log", () => {
  test("only the Supervisor reads the sensor history, filtered and newest first", async () => {
    const { coordinator, detections } = setup();
    const base = {
      title: "Lead",
      role: "lead",
      turnId: "t",
      stage: "turn-end" as const,
      semanticScore: 0.4,
      threshold: 0.7,
      jev: null,
      error: null,
    };
    await detections.record({
      ...base,
      at: "2026-10-27T00:00:00.000Z",
      agentId: "lead",
      patterns: ["blocked"],
      matched: "I'm blocked",
      confirmed: false,
    });
    await detections.record({
      ...base,
      at: "2026-10-27T00:01:00.000Z",
      agentId: "peer",
      patterns: ["repeated-failure"],
      matched: "still failing",
      confirmed: true,
    });
    const all = (await coordinator.call("sup", "sensor_log", {})) as {
      total: number;
      rules: { rule: string }[];
      entries: { agentId: string }[];
    };
    expect(all.total).toBe(2);
    expect(all.entries.map((entry) => entry.agentId)).toEqual(["peer", "lead"]);
    expect(all.rules.map((rule) => rule.rule).sort()).toEqual(["blocked", "repeated-failure"]);
    const rejected = (await coordinator.call("sup", "sensor_log", { confirmed: false })) as {
      entries: { agentId: string }[];
    };
    expect(rejected.entries.map((entry) => entry.agentId)).toEqual(["lead"]);
    await expect(coordinator.call("lead", "sensor_log", {})).rejects.toThrow(
      "outside the lead role",
    );
  });
});

describe("Overmind product intent", () => {
  test("the Supervisor asks the Human, records quoted answers, and the Lead reads them", async () => {
    const { coordinator, agents, seats } = setup();
    await expect(
      coordinator.call("lead", "product_intent", {
        action: "ask",
        project: "FirstBloom",
        questions: ["Cozy or hardcore?"],
      }),
    ).rejects.toThrow("belongs to the Supervisor");
    const asked = (await coordinator.call("sup", "product_intent", {
      action: "ask",
      project: "FirstBloom",
      questions: ["Who is the target player?"],
    })) as { questions: { id: string }[] };
    expect((await seats.get("sup"))["overmind.intent.open"]).toBe("1");
    agents.get("sup")!.timeline = [
      { type: "user_message", text: "Người chơi casual, chơi 10 phút mỗi ngày" },
    ];
    const answer = {
      questionId: asked.questions[0]!.id,
      question: "Who is the target player?",
      answer: "Casual players, 10-minute daily sessions",
      humanQuotes: ["chơi 10 phút mỗi ngày"],
    };
    await expect(
      coordinator.call("sup", "product_intent", {
        action: "record",
        project: "FirstBloom",
        answers: [{ ...answer, humanQuotes: ["hardcore players"] }],
      }),
    ).rejects.toThrow("OVERMIND_INTENT_DENIED");
    await coordinator.call("sup", "product_intent", {
      action: "record",
      project: "FirstBloom",
      answers: [answer],
    });
    expect(await seats.get("sup")).toEqual({});
    // Project names compare loosely, and the Lead can read what was recorded.
    expect(
      await coordinator.call("lead", "product_intent", { action: "read", project: "firstbloom" }),
    ).toMatchObject({
      open: [],
      entries: [{ answer: "Casual players, 10-minute daily sessions" }],
    });
  });
});

describe("Overmind dual-seat", () => {
  test("two blind Peers research one direction each and report together", async () => {
    const { coordinator, agents, created, sent, relay, api, seats } = setup();
    await expect(
      coordinator.call("sup", "dual_seat", {
        question: "x".repeat(10),
        directions: [],
      }),
    ).rejects.toThrow("outside the supervisor role");
    const result = (await coordinator.call("lead", "dual_seat", {
      question: "How should sessions be cached across restarts?",
      directions: [
        { label: "Redis cache", brief: "Keep sessions in a Redis instance." },
        { label: "SQLite", brief: "Persist sessions in the local SQLite file." },
      ],
      criteria: ["Survives a restart"],
      effort: "low",
    })) as { peers: { side: string; agentId: string }[] };
    // Both research Peers run at the chosen effort.
    for (const entry of created.slice(0, 2))
      expect(entry.options).toMatchObject({
        config: { provider: "overmind-peer/peer-model", thinkingOptionId: "low" },
      });
    const [a, b] = result.peers;
    expect(result.peers.map((peer) => peer.side)).toEqual(["A", "B"]);
    const briefA = created[0]!.options.prompt as string;
    expect(briefA).toContain("Redis instance");
    expect(briefA).not.toContain("SQLite");
    expect(briefA).toContain("do not modify files in the workspace");
    expect(agents.get(a!.agentId)!.title).toMatch(/ - Peer - Hướng A: Redis cache$/);
    expect(agents.get(b!.agentId)!.labels["overmind.dual_seat.side"]).toBe("B");
    expect((await seats.get("lead"))["overmind.dual_seat.status"]).toBe("0/2");
    await expect(
      coordinator.call("lead", "get_agent_status", { agentId: a!.agentId }),
    ).rejects.toThrow("OVERMIND_AWAIT_REPORT");

    agents.get(a!.agentId)!.timeline = [{ type: "assistant_message", text: "Redis works" }];
    await relay.onTurnEnded(api, hookAgent(a!.agentId, "overmind-peer", "lead"), {
      kind: "completed",
    });
    expect(sent).toEqual([]);
    expect((await seats.get("lead"))["overmind.dual_seat.status"]).toBe("1/2");

    await relay.onArchived(api, hookAgent(b!.agentId, "overmind-peer", "lead"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "lead" });
    expect(sent[0]!.text).toContain("Direction A: Redis cache");
    expect(sent[0]!.text).toContain("Redis works");
    expect(sent[0]!.text).toContain("Direction B: SQLite");
    expect(sent[0]!.text).toContain("archived before it reported back");
    expect(sent[0]!.text).toContain("- Survives a restart");
    expect(await seats.get("lead")).toEqual({});
  });
});

describe("Overmind relay", () => {
  test("a Lead reports to its Supervisor only after its own Peer work is back", async () => {
    const { coordinator, agents, sent, relay, api } = setup();
    await coordinator.call("sup", "send_agent_prompt", { agentId: "lead", prompt: "Ship X" });
    await coordinator.call("lead", "send_agent_prompt", { agentId: "peer", prompt: "Build X" });
    sent.length = 0;
    agents.get("lead")!.timeline = [{ type: "assistant_message", text: "Peer dispatched" }];
    await relay.onTurnEnded(api, hookAgent("lead", "overmind-lead", "sup"), { kind: "completed" });
    expect(sent).toEqual([]);
    agents.get("peer")!.timeline = [{ type: "assistant_message", text: "X built" }];
    await relay.onTurnEnded(api, hookAgent("peer", "overmind-peer", "lead"), { kind: "completed" });
    expect(sent.map((entry) => entry.to)).toEqual(["lead"]);
    agents.get("lead")!.timeline = [{ type: "assistant_message", text: "X shipped, verified" }];
    await relay.onTurnEnded(api, hookAgent("lead", "overmind-lead", "sup"), { kind: "completed" });
    expect(sent.at(-1)).toMatchObject({
      to: "sup",
      text: expect.stringContaining("X shipped, verified"),
    });
  });

  test("a turn that ended while the plugin was down is reported after reload", async () => {
    const { coordinator, agents, sent, relay, api } = setup();
    await coordinator.call("sup", "send_agent_prompt", { agentId: "lead", prompt: "Ship X" });
    // Still working, or prompted with no answer yet: nothing to report.
    agents.get("lead")!.status = "running";
    await relay.reconcile(api);
    agents.get("lead")!.status = "idle";
    agents.get("lead")!.timeline = [{ type: "user_message", text: "Ship X" }];
    await relay.reconcile(api);
    expect(sent.filter((entry) => entry.to === "sup")).toEqual([]);
    // The handback the plugin missed reaches the Supervisor once, after the reload.
    agents.get("lead")!.timeline.push({ type: "assistant_message", text: "X shipped" });
    await relay.reconcile(api);
    await relay.reconcile(api);
    expect(sent.filter((entry) => entry.to === "sup")).toEqual([
      expect.objectContaining({ text: expect.stringContaining("X shipped") }),
    ]);
  });

  test("a Lead asks its Supervisor mid-task and reports only once answered and done", async () => {
    const { coordinator, agents, sent, relay, api, seats } = setup();
    await coordinator.call("sup", "send_agent_prompt", { agentId: "lead", prompt: "Ship X" });
    await coordinator.call("lead", "send_agent_prompt", { agentId: "peer", prompt: "Build X" });
    await expect(
      coordinator.call("peer", "ask_supervisor", { question: "Which market first?" }),
    ).rejects.toThrow("OVERMIND_ROLE_DENIED");
    sent.length = 0;
    // The question goes up now, while the Peer is still working.
    await coordinator.call("lead", "ask_supervisor", {
      question: "Ship to EU or US first?",
      options: ["EU", "US"],
    });
    expect(sent).toEqual([
      expect.objectContaining({ to: "sup", text: expect.stringContaining("- EU") }),
    ]);
    expect((await seats.get("lead"))["overmind.ask.pending"]).toBe("supervisor");
    // The Supervisor may read the asking Lead's work to answer.
    await expect(
      coordinator.call("sup", "get_agent_activity", { agentId: "lead" }),
    ).resolves.toBeDefined();
    sent.length = 0;
    await relay.onTurnEnded(api, hookAgent("peer", "overmind-peer", "lead"), { kind: "completed" });
    agents.get("lead")!.timeline = [{ type: "assistant_message", text: "Peer done, still asking" }];
    await relay.onTurnEnded(api, hookAgent("lead", "overmind-lead", "sup"), { kind: "completed" });
    expect(sent.map((entry) => entry.to)).toEqual(["lead"]);
    await coordinator.call("sup", "send_agent_prompt", { agentId: "lead", prompt: "EU first" });
    expect(await seats.get("lead")).toEqual({});
    agents.get("lead")!.timeline = [{ type: "assistant_message", text: "Shipped to EU" }];
    await relay.onTurnEnded(api, hookAgent("lead", "overmind-lead", "sup"), { kind: "completed" });
    expect(sent.at(-1)).toMatchObject({
      to: "sup",
      text: expect.stringContaining("Shipped to EU"),
    });
  });

  test("pending reports survive a plugin reload", async () => {
    const statePath = path.join(directory, "state", "relay.json");
    const before = new Relay(undefined, statePath);
    before.expectFinish("peer", "lead");
    await before.flushState();
    expect(new Relay(undefined, statePath).awaitsReport("peer", "lead")).toBe(true);
  });

  test("reports delegated work and holds the notice until the requester is idle", async () => {
    const { coordinator, agents, sent, relay, api } = setup();
    await coordinator.call("lead", "send_agent_prompt", { agentId: "peer", prompt: "Check X" });
    sent.length = 0;
    agents.get("peer")!.timeline = [
      {
        type: "user_message",
        text: '<paseo-system version="1" kind="agent-message" source-agent-id="lead" message-id="m">\nCheck X\n</paseo-system>',
      },
      { type: "assistant_message", text: "X is fine" },
    ];
    agents.get("lead")!.status = "running";
    await relay.onTurnEnded(api, hookAgent("peer", "overmind-peer", "lead"), { kind: "completed" });
    expect(sent).toEqual([]);
    expect(relay.pending("lead")).toBe(1);
    agents.get("lead")!.status = "idle";
    await relay.onTurnEnded(api, hookAgent("lead", "overmind-lead", "sup"), { kind: "completed" });
    expect(sent).toEqual([
      expect.objectContaining({
        to: "lead",
        sourceAgentId: "peer",
        text: expect.stringContaining("X is fine"),
      }),
    ]);
    // The next Peer turn was not delegated, so nothing more is reported.
    sent.length = 0;
    await relay.onTurnEnded(api, hookAgent("peer", "overmind-peer", "lead"), { kind: "completed" });
    expect(sent).toEqual([]);
  });

  test("a parent waits for the report instead of polling the agent it dispatched", async () => {
    const { coordinator, sent, relay, api } = setup();
    const accepted = await coordinator.call("lead", "send_agent_prompt", {
      agentId: "peer",
      prompt: "Check X",
    });
    expect(accepted).toMatchObject({ next: expect.stringContaining("End your turn") });
    await expect(coordinator.call("lead", "get_agent_status", { agentId: "peer" })).rejects.toThrow(
      "OVERMIND_AWAIT_REPORT",
    );
    await expect(
      coordinator.call("lead", "get_agent_activity", { agentId: "peer" }),
    ).rejects.toThrow("OVERMIND_AWAIT_REPORT");
    await relay.onTurnEnded(api, hookAgent("peer", "overmind-peer", "lead"), { kind: "completed" });
    await expect(
      coordinator.call("lead", "get_agent_status", { agentId: "peer" }),
    ).resolves.toMatchObject({ agentId: "peer" });
    // A child archived mid-task still wakes the waiting parent.
    await coordinator.call("lead", "send_agent_prompt", { agentId: "peer", prompt: "Check Y" });
    sent.length = 0;
    await relay.onArchived(api, hookAgent("peer", "overmind-peer", "lead"));
    expect(sent).toEqual([
      expect.objectContaining({ to: "lead", text: expect.stringContaining("was archived") }),
    ]);
    expect(relay.awaitsReport("peer", "lead")).toBe(false);
  });

  test("tells the Lead when the Human briefs its Peer directly", async () => {
    const { agents, sent, relay, api } = setup();
    agents.get("peer")!.timeline = [
      { type: "user_message", text: "Also check the logout flow" },
      { type: "assistant_message", text: "Logout is broken" },
    ];
    await relay.onTurnEnded(api, hookAgent("peer", "overmind-peer", "lead"), { kind: "completed" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Human message:\nAlso check the logout flow");
    expect(sent[0]!.text).toContain("Logout is broken");
  });
});
