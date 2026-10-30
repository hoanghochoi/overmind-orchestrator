import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import type { SeatProfile } from "./providers.js";
import { CONTRACT_LABEL, createContractLock, readContractLock } from "./contract.js";
import {
  CREATION_TICKET_ENV,
  CreationTickets,
  NEXT_ROLE,
  assertPeerTask,
  assertScopeDispatch,
  assertTarget,
  denied,
  loadSeat,
  seatFrom,
  type Role,
  type Seat,
} from "./policy.js";
import { recentTimeline, type PanelMember, type Relay } from "./relay.js";
import {
  TASK_AGREEMENT_LABEL,
  assertReviewTarget,
  assertReviewable,
  createTaskAgreement,
  humanReviewContext,
  readTaskAgreement,
  supervisorReviewLabels,
  supervisorTaskInput,
} from "./review.js";
import type { SeatStore } from "./seat-store.js";
import { DetectionLog } from "./detection-log.js";
import { escalatedAntiPatterns, type RepetitionTracker } from "./repetition.js";
import { NAME_LABEL, pickName, seatTitle } from "./names.js";
import type { IntentStore } from "./intent-store.js";

const agentId = z.string().trim().min(1);
const prompt = z.string().trim().min(1).max(32_000);
const taskLabels = z
  .record(z.string().regex(/^overmind\.task\.[a-z_.]+$/), z.string().max(200))
  .optional();

interface ToolDefinition {
  description: string;
  schema: z.ZodType;
  roles: readonly Role[];
}

const BOTH = ["supervisor", "lead"] as const;
/** Open product-intent questions the Supervisor has put to the Human. */
export const INTENT_OPEN_LABEL = "overmind.intent.open";
const intentText = z.string().trim().min(1).max(4000);
const project = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Project name as list_workspaces reports it.");

/** Which direction ("A", "B") a dual-seat Peer researches. */
export const DUAL_SEAT_SIDE_LABEL = "overmind.dual_seat.side";

function dualSeatBrief(
  question: string,
  side: string,
  direction: { label: string; brief: string },
  criteria: readonly string[],
): string {
  return [
    `[Overmind dual-seat · direction ${side}]`,
    `Decision under study:\n${question}`,
    `Your direction: ${direction.label}\n${direction.brief}`,
    `Criteria:\n${criteria.length ? criteria.map((criterion) => `- ${criterion}`).join("\n") : "- None given."}`,
    "Research only this direction. Another Peer studies a different direction; you will not see its brief or result, and must not look for it.",
    "Read the code and gather the evidence you need, but do not modify files in the workspace or its git state. Build any prototype only in a new temporary directory outside the workspace.",
    "Report honestly, even against your direction: whether it is viable, the evidence (commands and their output), risks, the cost of adopting it, and your confidence.",
  ].join("\n\n");
}
const task = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe(
    "A few words naming the work, in the Human's language, e.g. \"Tạo ảnh cây cối\". Overmind titles the seat '<Name> - <Role> - <task>'.",
  );
const effort = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .describe(
    "Thinking level for the new agent, one its profile's model offers; an unknown level is refused with the valid ones. Omit for the configured default.",
  );
const AWAIT_REPORT =
  "End your turn now and wait idle. Overmind sends you its result as a new message when its turn ends; do not poll its status or activity, sleep, or loop while it works.";
export const COORDINATION_TOOLS = {
  list_agents: {
    description: "List agents with their Overmind role, parent, workspace and status.",
    schema: z.object({ includeArchived: z.boolean().optional() }).strict(),
    roles: BOTH,
  },
  get_agent_status: {
    description:
      "Status and Overmind task labels of an agent you coordinate. Refused while it still owes you a report: wait for that report instead.",
    schema: z.object({ agentId }).strict(),
    roles: BOTH,
  },
  get_agent_activity: {
    description:
      "Recent timeline of an agent you coordinate. Refused while it still owes you a report: wait for that report instead.",
    schema: z.object({ agentId, limit: z.number().int().min(1).max(50).optional() }).strict(),
    roles: BOTH,
  },
  list_workspaces: {
    description: "List local workspaces and their directories.",
    schema: z.object({}).strict(),
    roles: BOTH,
  },
  list_providers: {
    description: "List agent providers available on this host.",
    schema: z.object({}).strict(),
    roles: BOTH,
  },
  list_models: {
    description: "List models of a provider.",
    schema: z.object({ provider: z.string().trim().min(1) }).strict(),
    roles: BOTH,
  },
  create_agent: {
    description:
      "Supervisor: create an overmind-lead attached to you in workspaceId. Lead: create an overmind-peer attached to you in your workspace; pick an effort proportionate to the task. The prompt starts its first task; its result is reported back to you.",
    schema: z
      .object({
        prompt,
        task,
        workspaceId: z.string().trim().min(1).optional(),
        labels: taskLabels,
        effort: effort.optional(),
      })
      .strict(),
    roles: BOTH,
  },
  ask_supervisor: {
    description:
      "Lead only. Ask your Supervisor for a decision or approval you must not make yourself (product intent, priority, scope, an owner choice, choosing or accepting a candidate for review) without waiting for your Peers to finish. Your final message alone reaches the Supervisor only once no Peer is still working. The question is delivered now; then end your turn and wait idle for the answer.",
    schema: z
      .object({
        question: z.string().trim().min(10).max(4000),
        context: z.string().trim().max(8000).optional(),
        options: z.array(z.string().trim().min(1).max(500)).max(6).optional(),
      })
      .strict(),
    roles: ["lead"],
  },
  dual_seat: {
    description:
      "Lead only. For a hard decision, research two directions independently before choosing: Overmind creates one Peer per direction, at the given effort, each blind to the other and limited to reading and prototyping outside the workspace. Both results come back to you in one report; then converge on a decision.",
    schema: z
      .object({
        question: z.string().trim().min(10).max(4000),
        directions: z
          .array(
            z
              .object({
                label: z.string().trim().min(1).max(40),
                brief: z.string().trim().min(10).max(4000),
              })
              .strict(),
          )
          .length(2),
        criteria: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
        effort: effort.optional(),
      })
      .strict(),
    roles: ["lead"],
  },
  send_agent_prompt: {
    description:
      "Send a task or follow-up to a Lead (Supervisor) or to one of your Peers (Lead). Its turn result is reported back to you. Give task when the work changes: a Lead's workspace is retitled with it. After Overmind reports a repeated anti-pattern for the target, include newApproach: what changes from the approach that kept failing.",
    schema: z
      .object({
        agentId,
        prompt,
        activeTurnBehavior: z.enum(["steer", "interrupt"]).optional(),
        task: task.optional(),
        newApproach: z.string().trim().min(20).max(4000).optional(),
      })
      .strict(),
    roles: BOTH,
  },
  archive_agent: {
    description: "Archive a Lead or Peer that you own.",
    schema: z.object({ agentId }).strict(),
    roles: BOTH,
  },
  overmind_task_review: {
    description:
      "Supervisor only. Use context to read existing human discussion and the Lead's agreement. Record agreement with scope, acceptanceCriteria and exact humanQuotes; no repeat human approval is needed. Review the completed turn with agreementId, evidence and one check per criterion. Accept/reopen only within_agreement. A required scope change uses needs_human and requestedChange; wait for human input before reconciling the agreement. Never lower criteria to make work pass.",
    schema: supervisorTaskInput,
    roles: ["supervisor"],
  },
  product_intent: {
    description:
      "The Human's product intent per project, kept across tasks. read (Supervisor, Lead): recorded answers, newest first, and questions still open. ask (Supervisor): register the questions you are about to put to the Human, then ask them in your reply and end your turn. record (Supervisor): store the Human's answers with humanQuotes copied exactly from the Human's messages; questionId closes the open question it answers.",
    schema: z.discriminatedUnion("action", [
      z.object({ action: z.literal("read"), project }).strict(),
      z
        .object({
          action: z.literal("ask"),
          project,
          questions: z.array(intentText).min(1).max(5),
        })
        .strict(),
      z
        .object({
          action: z.literal("record"),
          project,
          answers: z
            .array(
              z
                .object({
                  questionId: z.string().trim().min(1).optional(),
                  question: intentText,
                  answer: intentText,
                  humanQuotes: z.array(intentText).min(1).max(10),
                })
                .strict(),
            )
            .min(1)
            .max(10),
        })
        .strict(),
    ]),
    roles: BOTH,
  },
  sensor_log: {
    description:
      "Supervisor only, read-only. Anomaly-sensor history for reviewing detection quality: per-rule hit and confirmation counts plus recent candidates, including those the semantic check rejected. Use it when the Human asks to evaluate or improve the sensor; recommend rule or threshold changes, do not apply them.",
    schema: z
      .object({
        limit: z.number().int().min(1).max(500).optional(),
        agentId: z.string().trim().min(1).optional(),
        rule: z.string().trim().min(1).optional(),
        confirmed: z.boolean().optional(),
      })
      .strict(),
    roles: ["supervisor"],
  },
  contract_lock: {
    description:
      "Lead only. Lock the current schema and API artifact files before delegating Peer test tasks. Content changes invalidate the lock. Unlock before revising a contract; read returns the stored fingerprints.",
    schema: z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("lock"),
          schemaPath: z.string().trim().min(1),
          apiContractPath: z.string().trim().min(1),
        })
        .strict(),
      z.object({ action: z.literal("unlock") }).strict(),
      z.object({ action: z.literal("read") }).strict(),
    ]),
    roles: ["lead"],
  },
} satisfies Record<string, ToolDefinition>;
export type CoordinationTool = keyof typeof COORDINATION_TOOLS;

export function toolsForRole(role: Role): CoordinationTool[] {
  return (Object.keys(COORDINATION_TOOLS) as CoordinationTool[]).filter((name) =>
    (COORDINATION_TOOLS[name].roles as readonly Role[]).includes(role),
  );
}

function summary(seat: Seat) {
  return {
    agentId: seat.id,
    title: seat.title,
    provider: seat.provider,
    role: seat.role,
    parentAgentId: seat.parentId,
    workspaceId: seat.workspaceId ?? null,
    cwd: seat.cwd,
    status: seat.status,
    archivedAt: seat.archivedAt,
    labels: Object.fromEntries(
      Object.entries(seat.labels).filter(
        ([key]) => key.startsWith("overmind.") && key !== TASK_AGREEMENT_LABEL,
      ),
    ),
  };
}

export interface CoordinatorDependencies {
  paseo: PaseoApi;
  seats: SeatStore;
  relay: Relay;
  tickets: CreationTickets;
  detections: DetectionLog;
  repetition: RepetitionTracker;
  intents: IntentStore;
  /** Registered profiles to create seats from; the SDK requires `provider/model`. */
  profiles: () => Promise<SeatProfile[]>;
}

/** Overmind's control plane: every call is checked against the caller's live role. */
export class Coordinator {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: CoordinatorDependencies) {}

  /** Serialize label mutations per Lead so checks and writes see one state. */
  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.locks.set(key, run);
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.locks.get(key) === run) this.locks.delete(key);
      });
    return run;
  }

  private seat(id: string): Promise<Seat | null> {
    return loadSeat(this.deps.paseo, this.deps.seats, id);
  }

  /** The live caller must hold a role the tool allows. */
  private async authorize(callerId: string, name: string) {
    const caller = await this.seat(callerId);
    if (!caller?.role || caller.archivedAt || caller.role === "peer")
      denied("Overmind tools require an active Supervisor or Lead");
    const tool = COORDINATION_TOOLS[name as CoordinationTool];
    if (!tool || !(tool.roles as readonly Role[]).includes(caller.role))
      denied(`${name} is outside the ${caller.role} role`);
    return { caller, tool };
  }

  async call(callerId: string, name: string, raw: unknown): Promise<unknown> {
    const { caller, tool } = await this.authorize(callerId, name);
    const input = tool.schema.parse(raw ?? {});
    const { paseo } = this.deps;
    switch (name as CoordinationTool) {
      case "list_agents": {
        const { includeArchived } = input as { includeArchived?: boolean };
        const page = await paseo.agents.list({ filter: { includeArchived } });
        const ids = page.entries.map((entry) => entry.agent.id);
        const overlays = await this.deps.seats.getMany(ids);
        return {
          agents: page.entries.map((entry) =>
            summary(seatFrom(entry.agent, overlays[entry.agent.id] ?? {})),
          ),
        };
      }
      case "get_agent_status": {
        const target = await this.seat((input as { agentId: string }).agentId);
        assertTarget(caller, name, target);
        this.assertNotAwaiting(caller, target);
        return { ...summary(target), lastUserMessageAt: target.lastUserMessageAt };
      }
      case "get_agent_activity": {
        const { agentId: id, limit } = input as { agentId: string; limit?: number };
        const target = await this.seat(id);
        assertTarget(caller, name, target);
        this.assertNotAwaiting(caller, target);
        const items = await recentTimeline(paseo, target.id, limit ?? 20);
        return {
          items: items.map((item) => ({ type: item.type, text: item.text?.slice(0, 2000) })),
        };
      }
      case "list_workspaces": {
        const page = await paseo.workspaces.list();
        return {
          workspaces: page.entries.map((workspace) => ({
            workspaceId: workspace.id,
            name: workspace.name,
            project: workspace.projectDisplayName,
            directory: workspace.workspaceDirectory ?? null,
            kind: workspace.workspaceKind,
          })),
        };
      }
      case "list_providers":
        return paseo.providers.listAvailable();
      case "list_models":
        return paseo.providers.listModels((input as { provider: string }).provider);
      case "create_agent":
        return this.createAgent(
          caller,
          input as z.infer<typeof COORDINATION_TOOLS.create_agent.schema>,
        );
      case "ask_supervisor":
        return this.askSupervisor(
          caller,
          input as z.infer<typeof COORDINATION_TOOLS.ask_supervisor.schema>,
        );
      case "dual_seat":
        return this.dualSeat(caller, input as z.infer<typeof COORDINATION_TOOLS.dual_seat.schema>);
      case "send_agent_prompt":
        return this.sendPrompt(
          caller,
          input as z.infer<typeof COORDINATION_TOOLS.send_agent_prompt.schema>,
        );
      case "archive_agent": {
        const target = await this.seat((input as { agentId: string }).agentId);
        assertTarget(caller, name, target);
        this.deps.relay.forget(target.id);
        return paseo.agents.ref(target.id).archive();
      }
      case "overmind_task_review":
        return this.review(caller, input as z.infer<typeof supervisorTaskInput>);
      case "product_intent":
        return this.productIntent(
          caller,
          input as z.infer<typeof COORDINATION_TOOLS.product_intent.schema>,
        );
      case "sensor_log":
        return this.sensorLog(input as z.infer<typeof COORDINATION_TOOLS.sensor_log.schema>);
      case "contract_lock":
        return this.contractLock(
          caller,
          input as z.infer<typeof COORDINATION_TOOLS.contract_lock.schema>,
        );
    }
  }

  private async sensorLog(filter: z.infer<typeof COORDINATION_TOOLS.sensor_log.schema>) {
    const entries = (await this.deps.detections.read()).filter(
      (entry) =>
        (!filter.agentId || entry.agentId === filter.agentId) &&
        (!filter.rule || entry.patterns.includes(filter.rule)) &&
        (filter.confirmed === undefined || entry.confirmed === filter.confirmed),
    );
    const antiPatterns: Record<string, number> = {};
    for (const entry of entries)
      for (const antiPattern of entry.antiPatterns)
        antiPatterns[antiPattern] = (antiPatterns[antiPattern] ?? 0) + 1;
    return {
      total: entries.length,
      antiPatterns,
      rules: DetectionLog.summarize(entries),
      entries: entries.slice(-(filter.limit ?? 50)).toReversed(),
    };
  }

  private async createAgent(
    caller: Seat,
    input: z.infer<typeof COORDINATION_TOOLS.create_agent.schema>,
  ) {
    const role = NEXT_ROLE[caller.role!]!;
    const workspaceId = role === "lead" ? input.workspaceId : caller.workspaceId;
    if (!workspaceId) denied("a Lead needs the target workspaceId");
    if (role === "peer" && input.workspaceId && input.workspaceId !== caller.workspaceId)
      denied("a Peer stays in its Lead's workspace");
    const lead = role === "lead" ? null : caller;
    return this.exclusive(lead?.id ?? caller.id, async () => {
      const id = await this.spawn(caller, role, workspaceId, input);
      this.deps.relay.expectFinish(id, caller.id);
      return { agentId: id, role, workspaceId, next: AWAIT_REPORT };
    });
  }

  /** Creates the caller's next role; callers hold the dispatching Lead's exclusive lock. */
  private async spawn(
    caller: Seat,
    role: Role,
    workspaceId: string,
    input: {
      prompt: string;
      task: string;
      labels?: Record<string, string>;
      effort?: string;
    },
  ): Promise<string> {
    const profile = await this.profileFor(role);
    if (input.effort && !profile.efforts.includes(input.effort))
      denied(
        `effort ${input.effort} is not offered by ${role}; choose one of: ${profile.efforts.join(", ") || "none"}`,
      );
    const labels: Record<string, string> = { ...input.labels };
    if (role === "peer") {
      assertScopeDispatch(caller);
      if (await assertPeerTask(labels, caller, input.prompt))
        labels["overmind.task.kind"] = "test-generation";
    }
    const name = await this.freeName();
    labels[NAME_LABEL] = name;
    const title = seatTitle(name, role, input.task);
    // A Lead owns its workspace; Peers share it, so only a Lead names it.
    if (role === "lead") await this.deps.paseo.workspaces.ref(workspaceId).setTitle(title);
    const handle = await this.deps.paseo.workspaces.ref(workspaceId).agents.create({
      config: {
        provider: `${profile.provider}/${profile.model}`,
        ...(input.effort ? { thinkingOptionId: input.effort } : {}),
      },
      parent: caller.id,
      title,
      prompt: input.prompt,
      labels,
      env: { [CREATION_TICKET_ENV]: this.deps.tickets.issue(role, caller.id) },
    });
    return handle.id;
  }

  private async profileFor(role: Role): Promise<SeatProfile> {
    const profile = (await this.deps.profiles()).find((entry) => entry.role === role);
    if (profile) return profile;
    throw new Error(`Chưa cấu hình model cho Overmind ${role}. Mở Overmind Command → Settings.`);
  }

  private async productIntent(
    caller: Seat,
    input: z.infer<typeof COORDINATION_TOOLS.product_intent.schema>,
  ) {
    const { intents } = this.deps;
    if (input.action === "read") return intents.read(input.project);
    if (caller.role !== "supervisor")
      denied(`product_intent ${input.action} belongs to the Supervisor`);
    if (input.action === "ask") {
      const questions = await intents.ask(input.project, input.questions);
      await this.deps.seats.merge(caller.id, {
        [INTENT_OPEN_LABEL]: String(await intents.openCount()),
      });
      return {
        questions,
        next: "Put these questions to the Human now in your reply, in the Human's language, then end your turn. When the Human answers, call record with their exact words and the questionId.",
      };
    }
    // shortcut: reads the last 200 items; an answer older than that cannot be quoted.
    const { messages } = humanReviewContext(await recentTimeline(this.deps.paseo, caller.id, 200));
    const unquoted = input.answers
      .flatMap((answer) => answer.humanQuotes)
      .filter((quote) => !messages.some((message) => message.includes(quote)));
    if (unquoted.length)
      throw new Error(
        `OVERMIND_INTENT_DENIED: these quotes are not in the Human's messages to you: ${unquoted.map((quote) => JSON.stringify(quote)).join(", ")}`,
      );
    const recorded = await intents.record(
      input.project,
      input.answers.map(({ question, answer, humanQuotes }) => ({ question, answer, humanQuotes })),
      input.answers.flatMap((answer) => (answer.questionId ? [answer.questionId] : [])),
    );
    const open = await intents.openCount();
    await this.deps.seats.merge(caller.id, { [INTENT_OPEN_LABEL]: open ? String(open) : "" });
    return { recorded, open: (await intents.read(input.project)).open };
  }

  private async askSupervisor(
    lead: Seat,
    input: z.infer<typeof COORDINATION_TOOLS.ask_supervisor.schema>,
  ) {
    const supervisor = lead.parentId ? await this.seat(lead.parentId) : null;
    if (supervisor?.role !== "supervisor" || supervisor.archivedAt)
      denied("this Lead has no live Supervisor");
    const lines = [
      `[Overmind · Lead question] ${lead.title ?? "Lead"} (${lead.id}) needs your decision and waits idle for it; its own Peers may still be working.`,
      `Question:\n${input.question}`,
      ...(input.context ? [`Context:\n${input.context}`] : []),
      ...(input.options?.length
        ? [`Options:\n${input.options.map((option) => `- ${option}`).join("\n")}`]
        : []),
      `Answer with send_agent_prompt to ${lead.id}. If the answer depends on the Human's product intent or changes the agreed scope, ask the Human first and relay the decision precisely.`,
    ];
    await this.deps.relay.expectAnswer(lead.id);
    await this.deps.relay.deliver(this.deps.paseo, supervisor.id, {
      text: lines.join("\n\n"),
      sourceAgentId: lead.id,
    });
    return {
      supervisorId: supervisor.id,
      next: "End your turn now and wait idle. The Supervisor's answer arrives as a new message; your Peers' reports still reach you meanwhile.",
    };
  }

  private dualSeat(lead: Seat, input: z.infer<typeof COORDINATION_TOOLS.dual_seat.schema>) {
    const workspaceId = lead.workspaceId;
    if (!workspaceId) denied("a dual-seat needs the Lead's workspace");
    const criteria = input.criteria ?? [];
    return this.exclusive(lead.id, async () => {
      const members: PanelMember[] = [];
      try {
        for (const [index, direction] of input.directions.entries()) {
          const side = String.fromCharCode(65 + index);
          const id = await this.spawn(lead, "peer", workspaceId, {
            prompt: dualSeatBrief(input.question, side, direction, criteria),
            task: `Hướng ${side}: ${direction.label}`,
            labels: { [DUAL_SEAT_SIDE_LABEL]: side },
            effort: input.effort,
          });
          members.push({ id, side, label: direction.label });
        }
      } catch (error) {
        // A lone direction never converges; withdraw it rather than leave the Lead waiting.
        for (const member of members)
          await this.deps.paseo.agents
            .ref(member.id)
            .archive()
            .catch(() => undefined);
        throw error;
      }
      await this.deps.relay.expectPanel(lead.id, input.question, criteria, members);
      return {
        peers: members.map((member) => ({ side: member.side, agentId: member.id })),
        next: "End your turn now and wait idle. Overmind sends both results together in one report once every direction has reported; do not poll the Peers, sleep, or loop.",
      };
    });
  }

  private async freeName(): Promise<string> {
    const page = await this.deps.paseo.agents.list();
    const taken = new Set(
      page.entries.map(
        (entry) => entry.agent.labels?.[NAME_LABEL] ?? entry.agent.title?.split(" - ")[0] ?? "",
      ),
    );
    return pickName(taken);
  }

  private assertNotAwaiting(caller: Seat, target: Seat): void {
    // A Supervisor answering its Lead's question may read the Lead's work.
    if (this.deps.relay.isAsking(target.id)) return;
    if (this.deps.relay.awaitsReport(target.id, caller.id))
      throw new Error(
        `OVERMIND_AWAIT_REPORT: ${target.id} is still working on what you sent it. ${AWAIT_REPORT}`,
      );
  }

  private async sendPrompt(
    caller: Seat,
    input: z.infer<typeof COORDINATION_TOOLS.send_agent_prompt.schema>,
  ) {
    const target = await this.seat(input.agentId);
    assertTarget(caller, "send_agent_prompt", target);
    const lead = target.role === "lead" ? target : caller;
    return this.exclusive(lead.id, async () => {
      assertScopeDispatch(lead);
      if (target.role === "peer" && (await assertPeerTask(target.labels, lead, input.prompt)))
        await this.deps.seats.merge(target.id, { "overmind.task.kind": "test-generation" });
      const stalled = escalatedAntiPatterns(target.labels);
      if (stalled.length && !input.newApproach)
        throw new Error(
          `OVERMIND_REDIRECT_REQUIRED: ${target.id} repeated ${stalled.join(", ")} without progress; resend with newApproach describing a different direction`,
        );
      const text = input.newApproach
        ? `${input.prompt}\n\nNew approach (replaces the one that kept failing): ${input.newApproach}`
        : input.prompt;
      await this.deps.paseo.agents.ref(target.id).send(text, {
        sourceAgentId: caller.id,
        activeTurnBehavior: input.activeTurnBehavior ?? "steer",
      });
      if (input.newApproach) await this.deps.repetition.redirect(target.id);
      if (caller.role === "supervisor") await this.deps.relay.answered(target.id);
      // Paseo cannot retitle an agent after creation; the Lead's workspace carries the current work.
      const name = target.labels[NAME_LABEL];
      if (input.task && name && target.role === "lead" && target.workspaceId)
        await this.deps.paseo.workspaces
          .ref(target.workspaceId)
          .setTitle(seatTitle(name, "lead", input.task));
      this.deps.relay.expectFinish(target.id, caller.id);
      return { agentId: target.id, accepted: true, next: AWAIT_REPORT };
    });
  }

  private review(supervisor: Seat, input: z.infer<typeof supervisorTaskInput>) {
    return this.exclusive(input.agentId, async () => {
      const target = await this.seat(input.agentId);
      assertReviewTarget(supervisor, target);
      // shortcut: reads the last 200 items; a longer brainstorm needs paging here.
      const timeline = await recentTimeline(this.deps.paseo, supervisor.id, 200);
      if (input.action === "context")
        return {
          humanMessages: humanReviewContext(timeline).messages,
          agreement: readTaskAgreement(target),
          turnId: target.labels["overmind.turn.id"] ?? null,
          status: target.labels["overmind.task.status"] ?? null,
        };
      if (input.action === "agreement") {
        const agreement = createTaskAgreement(supervisor, target, input, timeline);
        const resumed = target.labels["overmind.review.decision"] === "needs_human";
        await this.deps.seats.merge(target.id, {
          [TASK_AGREEMENT_LABEL]: JSON.stringify(agreement),
          ...(resumed
            ? {
                "overmind.review.decision": "",
                "overmind.task.status":
                  target.status === "idle" && target.labels["overmind.turn.outcome"] === "completed"
                    ? "READY_FOR_REVIEW"
                    : "IN_PROGRESS",
              }
            : {}),
        });
        return { agreement };
      }
      const labels = supervisorReviewLabels(supervisor, target, input, timeline);
      assertReviewable(target, labels);
      await this.deps.seats.merge(target.id, labels);
      return { agentId: target.id, labels };
    });
  }

  private contractLock(lead: Seat, input: z.infer<typeof COORDINATION_TOOLS.contract_lock.schema>) {
    return this.exclusive(lead.id, async () => {
      if (input.action === "lock") {
        const lock = await createContractLock(lead, input.schemaPath, input.apiContractPath);
        await this.deps.seats.merge(lead.id, { [CONTRACT_LABEL]: JSON.stringify(lock) });
      } else if (input.action === "unlock") {
        await this.deps.seats.merge(lead.id, { [CONTRACT_LABEL]: "" });
      }
      const current = await this.seat(lead.id);
      return { lock: current ? readContractLock(current) : null };
    });
  }
}
