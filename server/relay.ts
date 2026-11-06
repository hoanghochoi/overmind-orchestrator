import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type {
  PluginHookAgent,
  PluginTurnOutcome,
} from "@getpaseo/plugin/server";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { roleForProvider } from "../shared/providers.js";
import { humanText } from "./envelope.js";
import type { TimelineText } from "./review.js";
import type { SeatStore } from "./seat-store.js";

/** Lead label showing how many dual-seat directions have reported, e.g. "1/2". */
export const DUAL_SEAT_STATUS_LABEL = "overmind.dual_seat.status";
/** Set on a Lead while its question to the Supervisor is unanswered. */
export const ASKING_LABEL = "overmind.ask.pending";

const MAX_EXCERPT = 4000;

export async function recentTimeline(
  paseo: PaseoApi,
  agentId: string,
  limit: number
): Promise<TimelineText[]> {
  const page = await paseo.agents
    .ref(agentId)
    .timeline.refetch({ direction: "tail", limit });
  return page.entries.map((entry) => entry.item as TimelineText);
}

function excerpt(text: string): string {
  return text.length > MAX_EXCERPT
    ? `${text.slice(0, MAX_EXCERPT)}\n…(truncated)`
    : text;
}

function describeOutcome(outcome: PluginTurnOutcome): string {
  if (outcome.kind === "failed") return `failed: ${outcome.error.message}`;
  if (outcome.kind === "canceled") return `canceled: ${outcome.reason}`;
  return "completed";
}

function humanNotice(peerId: string, human: string | null): string[] {
  if (!human) return [];
  return [
    `Runtime notice: the Human owner sent a direct message to your Peer ${peerId}. Keep this intervention in your task context; the Peer retains you as its Lead.`,
    `Human message:\n${excerpt(human)}`,
  ];
}

interface Pending {
  text: string;
  sourceAgentId: string;
}

interface PeerQuestion {
  peerId: string;
  leadId: string;
  requestId: string;
  text: string;
}

export interface PanelMember {
  id: string;
  side: string;
  label: string;
}

/** One dual-seat decision: its directions report together once all are in. */
interface Panel {
  parentId: string;
  question: string;
  criteria: readonly string[];
  members: readonly PanelMember[];
  results: Map<string, string>;
}

interface Snapshot {
  awaiting: Record<string, string[]>;
  queues: Record<string, Pending[]>;
  questions?: Record<string, PeerQuestion>;
  panels: (Omit<Panel, "results"> & { results: [string, string][] })[];
  asking?: string[];
}

/**
 * Agent-to-agent delivery for Overmind. Notices wait for an idle recipient so they
 * never steer a running turn, and delegated work reports back to its requester once
 * the child has nothing of its own still out. Parents wait idle on these reports, so
 * the state survives plugin reloads in `statePath`.
 */
export class Relay {
  private readonly awaiting = new Map<string, Set<string>>();
  private readonly queues = new Map<string, Pending[]>();
  private readonly questions = new Map<string, PeerQuestion>();
  /** Prevent a concurrent reconciliation from resurrecting a just-resolved request. */
  private readonly resolvedQuestions = new Set<string>();
  private readonly panels = new Map<string, Panel>();
  private readonly asking = new Set<string>();
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly seats?: SeatStore,
    private readonly statePath?: string
  ) {
    if (statePath) this.restore(statePath);
  }

  private restore(path: string): void {
    let snapshot: Snapshot;
    try {
      snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    } catch {
      return;
    }
    for (const [child, parents] of Object.entries(snapshot.awaiting ?? {}))
      this.awaiting.set(child, new Set(parents));
    for (const [recipient, queue] of Object.entries(snapshot.queues ?? {}))
      if (queue.length) this.queues.set(recipient, queue);
    for (const [key, question] of Object.entries(snapshot.questions ?? {}))
      if (question?.peerId && question.leadId && question.requestId)
        this.questions.set(key, question);
    for (const agentId of snapshot.asking ?? []) this.asking.add(agentId);
    for (const stored of snapshot.panels ?? []) {
      const panel: Panel = { ...stored, results: new Map(stored.results) };
      for (const member of panel.members)
        if (!panel.results.has(member.id)) this.panels.set(member.id, panel);
    }
  }

  private persist(): void {
    const path = this.statePath;
    if (!path) return;
    const snapshot: Snapshot = {
      awaiting: Object.fromEntries(
        [...this.awaiting].map(([child, parents]) => [child, [...parents]])
      ),
      queues: Object.fromEntries(this.queues),
      questions: Object.fromEntries(this.questions),
      asking: [...this.asking],
      panels: [...new Set(this.panels.values())].map(
        ({ parentId, question, criteria, members, results }) => ({
          parentId,
          question,
          criteria,
          members,
          results: [...results],
        })
      ),
    };
    const text = JSON.stringify(snapshot);
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
        return undefined;
      })
      .catch(() => undefined);
  }

  async flushState(): Promise<void> {
    await this.saving;
  }

  /** Delegated work, a dual-seat or a queued notice will bring this agent another turn. */
  private hasWorkOut(agentId: string): boolean {
    if (this.queues.has(agentId) || this.asking.has(agentId)) return true;
    for (const parents of this.awaiting.values())
      if (parents.has(agentId)) return true;
    for (const panel of this.panels.values())
      if (panel.parentId === agentId) return true;
    return false;
  }

  /**
   * Parents owed a report at this turn end. A Lead that dispatched a Peer and ended its
   * turn is still working on the task, so its parent hears from it at the turn that
   * ends with nothing left out.
   */
  private takeParents(agentId: string): Set<string> {
    const parents = this.awaiting.get(agentId);
    if (!parents || this.hasWorkOut(agentId)) return new Set();
    this.awaiting.delete(agentId);
    this.persist();
    return new Set(parents);
  }

  /** The members' results are held and delivered to the parent as one report. */
  async expectPanel(
    parentId: string,
    question: string,
    criteria: readonly string[],
    members: readonly PanelMember[]
  ): Promise<void> {
    const panel: Panel = {
      parentId,
      question,
      criteria,
      members,
      results: new Map(),
    };
    for (const member of members) this.panels.set(member.id, panel);
    this.persist();
    await this.seats?.merge(parentId, {
      [DUAL_SEAT_STATUS_LABEL]: `0/${members.length}`,
    });
  }

  /** The child reports to the parent at the first turn end with nothing of its own still out. */
  expectFinish(childId: string, parentId: string): void {
    const parents = this.awaiting.get(childId) ?? new Set<string>();
    parents.add(parentId);
    this.awaiting.set(childId, parents);
    this.persist();
  }

  /** True while the parent is owed a report for work it dispatched to the child. */
  awaitsReport(childId: string, parentId: string): boolean {
    return (
      (this.awaiting.get(childId)?.has(parentId) ?? false) ||
      this.panels.get(childId)?.parentId === parentId
    );
  }

  async deliver(
    paseo: PaseoApi,
    recipientId: string,
    pending: Pending
  ): Promise<void> {
    const queue = this.queues.get(recipientId);
    if (queue) {
      queue.push(pending);
      this.persist();
      return;
    }
    const current = (await paseo.agents.ref(recipientId).refresh())?.agent;
    if (!current || current.archivedAt) return;
    if (current.status === "running" || current.activeTurn) {
      this.queues.set(recipientId, [pending]);
      this.persist();
      return;
    }
    await paseo.agents.ref(recipientId).send(pending.text, {
      sourceAgentId: pending.sourceAgentId,
      activeTurnBehavior: "steer",
    });
  }

  private questionKey(peerId: string, requestId: string): string {
    return `${peerId}:${requestId}`;
  }

  private questionText(request: AgentPermissionRequest): string {
    const input = request.input as { questions?: unknown } | undefined;
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    const lines = questions.map((entry, index) => {
      const question = entry as {
        header?: unknown;
        question?: unknown;
        title?: unknown;
      };
      const header =
        typeof question.header === "string"
          ? question.header
          : `Question ${index + 1}`;
      const text =
        typeof question.question === "string"
          ? question.question
          : question.title;
      return `${header}: ${
        typeof text === "string" ? text : "(missing question text)"
      }`;
    });
    return (
      lines.join("\n") ||
      request.description ||
      request.title ||
      "Peer needs an answer."
    );
  }

  /** Persist and relay a Peer question to its direct Lead exactly once per request. */
  async notifyPeerQuestion(
    paseo: PaseoApi,
    peerId: string,
    leadId: string,
    request: AgentPermissionRequest
  ): Promise<void> {
    if (request.kind !== "question") return;
    const key = this.questionKey(peerId, request.id);
    if (this.resolvedQuestions.has(key)) return;
    if (this.questions.has(key)) return;
    const question: PeerQuestion = {
      peerId,
      leadId,
      requestId: request.id,
      text: this.questionText(request),
    };
    this.questions.set(key, question);
    this.persist();
    await this.deliver(paseo, leadId, {
      sourceAgentId: peerId,
      text: [
        "[OVERMIND PEER QUESTION]",
        `Peer ${peerId} needs an answer before it can continue.`,
        `Request ID: ${request.id}`,
        `Question:\n${question.text}`,
        "Lead hãy dùng answer_peer_question với đúng agentId, requestId và câu trả lời; không chuyển câu hỏi này cho Human permission queue.",
      ].join("\n\n"),
    });
  }

  clearPeerQuestion(peerId: string, requestId: string): void {
    const key = this.questionKey(peerId, requestId);
    this.resolvedQuestions.add(key);
    if (this.questions.delete(key)) this.persist();
  }

  /** Recover questions created while the plugin was reloading or disconnected. */
  async reconcilePeerQuestions(paseo: PaseoApi): Promise<void> {
    const active = new Set<string>();
    const page = await paseo.agents.list({});
    for (const entry of page.entries) {
      const agent = entry.agent;
      if (agent.archivedAt || roleForProvider(agent.provider) !== "peer")
        continue;
      const parentId = getParentAgentIdFromLabels(agent.labels);
      if (!parentId) continue;
      const current = await paseo.agents.ref(agent.id).refresh();
      for (const request of current?.agent.pendingPermissions ?? []) {
        if (request.kind !== "question") continue;
        active.add(this.questionKey(agent.id, request.id));
        await this.notifyPeerQuestion(paseo, agent.id, parentId, request);
      }
    }
    for (const [key, question] of this.questions)
      if (!active.has(key)) this.questions.delete(key);
    this.persist();
  }

  pending(recipientId: string): number {
    return this.queues.get(recipientId)?.length ?? 0;
  }

  /** Report finished delegated work, then release one queued notice to the now idle agent. */
  async onTurnEnded(
    paseo: PaseoApi,
    agent: PluginHookAgent,
    outcome: PluginTurnOutcome
  ): Promise<void> {
    if (this.panels.has(agent.id)) {
      await this.settleTurn(paseo, agent.id, outcome);
      return;
    }
    const role = roleForProvider(agent.provider);
    if (this.asking.has(agent.id))
      await this.clearIfHumanAnswered(paseo, agent.id);
    const parents = this.takeParents(agent.id);
    let human: string | null = null;
    let result = "";
    if (role && (parents.size || role === "peer")) {
      const timeline = await recentTimeline(paseo, agent.id, 30);
      const lastUser = timeline.findLast(
        (item) => item.type === "user_message"
      );
      human =
        role === "peer" && lastUser?.text ? humanText(lastUser.text) : null;
      result =
        timeline.findLast((item) => item.type === "assistant_message")?.text ??
        "";
    }
    // A Human may brief a Peer directly; its Lead keeps the context and the result.
    if (human && agent.parentAgentId) parents.add(agent.parentAgentId);
    const label = `${role ?? "agent"} ${agent.title ?? ""} (${
      agent.id
    })`.replace(/\s+/g, " ");
    for (const parentId of parents) {
      const lines = [
        ...humanNotice(
          agent.id,
          parentId === agent.parentAgentId ? human : null
        ),
        `[Overmind] ${label} finished its turn: ${describeOutcome(outcome)}.`,
        result
          ? `Final response:\n${excerpt(result)}`
          : "No final response text was recorded.",
      ];
      await this.deliver(paseo, parentId, {
        text: lines.join("\n\n"),
        sourceAgentId: agent.id,
      });
    }
    await this.flush(paseo, agent.id);
  }

  /**
   * Turn ends that fired while the plugin was not loaded were never reported. A child still
   * owing one that is idle with a response after its last prompt finished unobserved.
   */
  async reconcile(paseo: PaseoApi): Promise<void> {
    for (const childId of new Set([
      ...this.awaiting.keys(),
      ...this.panels.keys(),
    ])) {
      const agent = (await paseo.agents.ref(childId).refresh())?.agent;
      if (
        !agent ||
        agent.archivedAt ||
        agent.status === "running" ||
        agent.activeTurn
      )
        continue;
      const timeline = await recentTimeline(paseo, childId, 30);
      const prompted = timeline.findLastIndex(
        (item) => item.type === "user_message"
      );
      if (
        !timeline
          .slice(prompted + 1)
          .some((item) => item.type === "assistant_message")
      )
        continue;
      await this.onTurnEnded(
        paseo,
        {
          id: agent.id,
          workspaceId: agent.workspaceId ?? null,
          parentAgentId: getParentAgentIdFromLabels(agent.labels) ?? null,
          provider: agent.provider,
          cwd: agent.cwd,
          title: agent.title,
        },
        { kind: "completed" }
      );
    }
  }

  private async settleTurn(
    paseo: PaseoApi,
    memberId: string,
    outcome: PluginTurnOutcome
  ): Promise<void> {
    const timeline = await recentTimeline(paseo, memberId, 30);
    const result = timeline.findLast(
      (item) => item.type === "assistant_message"
    )?.text;
    await this.settle(
      paseo,
      memberId,
      `${describeOutcome(outcome)}\n\n${
        result ? excerpt(result) : "No final response text was recorded."
      }`
    );
    await this.flush(paseo, memberId);
  }

  private async settle(
    paseo: PaseoApi,
    memberId: string,
    result: string
  ): Promise<void> {
    const panel = this.panels.get(memberId);
    if (!panel) return;
    this.panels.delete(memberId);
    panel.results.set(memberId, result);
    this.persist();
    const total = panel.members.length;
    if (panel.results.size < total) {
      await this.seats?.merge(panel.parentId, {
        [DUAL_SEAT_STATUS_LABEL]: `${panel.results.size}/${total}`,
      });
      return;
    }
    await this.seats?.merge(panel.parentId, { [DUAL_SEAT_STATUS_LABEL]: "" });
    const criteria = panel.criteria.length
      ? panel.criteria.map((criterion) => `- ${criterion}`).join("\n")
      : "- None given: name the criteria you decide by.";
    const lines = [
      `[Overmind dual-seat] All ${total} directions on this decision have reported. Each Peer researched blind to the others.`,
      `Decision:\n${panel.question}`,
      `Criteria:\n${criteria}`,
      ...panel.members.map(
        (member) =>
          `Direction ${member.side}: ${member.label} (Peer ${
            member.id
          })\n${panel.results.get(member.id)}`
      ),
      "Converge now: compare the directions against the criteria, choose one (or a synthesis you justify), and state why each other direction was rejected. Then hand the chosen direction to an implementing Peer or report the decision.",
    ];
    await this.deliver(paseo, panel.parentId, {
      text: lines.join("\n\n"),
      sourceAgentId: panel.members.at(-1)!.id,
    });
  }

  private async flush(paseo: PaseoApi, recipientId: string): Promise<void> {
    const queue = this.queues.get(recipientId);
    const next = queue?.shift();
    if (!queue || !next) return;
    if (!queue.length) this.queues.delete(recipientId);
    this.persist();
    await paseo.agents.ref(recipientId).send(next.text, {
      sourceAgentId: next.sourceAgentId,
      activeTurnBehavior: "steer",
    });
  }

  /** An archived or closed agent receives nothing further. */
  forget(agentId: string): void {
    this.queues.delete(agentId);
    this.awaiting.delete(agentId);
    this.asking.delete(agentId);
    for (const [key, question] of this.questions)
      if (question.peerId === agentId || question.leadId === agentId)
        this.questions.delete(key);
    for (const key of this.resolvedQuestions)
      if (key.startsWith(`${agentId}:`)) this.resolvedQuestions.delete(key);
    this.persist();
  }

  /** The agent waits idle for its Supervisor's answer; its task report waits with it. */
  async expectAnswer(agentId: string): Promise<void> {
    this.asking.add(agentId);
    this.persist();
    await this.seats?.merge(agentId, { [ASKING_LABEL]: "supervisor" });
  }

  isAsking(agentId: string): boolean {
    return this.asking.has(agentId);
  }

  async answered(agentId: string): Promise<void> {
    if (!this.asking.delete(agentId)) return;
    this.persist();
    await this.seats?.merge(agentId, { [ASKING_LABEL]: "" });
  }

  /** The Human may answer the Lead directly instead of the Supervisor. */
  private async clearIfHumanAnswered(
    paseo: PaseoApi,
    agentId: string
  ): Promise<void> {
    const timeline = await recentTimeline(paseo, agentId, 30);
    const lastUser = timeline.findLast((item) => item.type === "user_message");
    if (lastUser?.text && humanText(lastUser.text))
      await this.answered(agentId);
  }

  /** Parents idle on a report would otherwise wait forever for a child archived mid-task. */
  async onArchived(paseo: PaseoApi, agent: PluginHookAgent): Promise<void> {
    if (this.panels.has(agent.id)) {
      this.queues.delete(agent.id);
      await this.settle(
        paseo,
        agent.id,
        "archived before it reported back; no result."
      );
      return;
    }
    const parents = [...(this.awaiting.get(agent.id) ?? [])];
    this.forget(agent.id);
    const label = `${agent.title ?? ""} (${agent.id})`.trim();
    for (const parentId of parents)
      await this.deliver(paseo, parentId, {
        text: `[Overmind] ${label} was archived before it reported back; no result will arrive for the work you sent it.`,
        sourceAgentId: agent.id,
      });
  }
}
