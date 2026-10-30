import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { humanText } from "./envelope.js";
import { denied, type Seat } from "./policy.js";

export const TASK_AGREEMENT_LABEL = "overmind.task.agreement";
export const REVIEW_STATUSES = new Map([
  ["accepted", "DONE"],
  ["reopened", "IN_PROGRESS"],
  ["needs_human", "WAITING_FOR_HUMAN"],
]);
const text = z.string().trim().min(1).max(4000);
const agreementInput = z.object({
  agentId: z.string().min(1),
  scope: text,
  acceptanceCriteria: z.array(text).min(1).max(20),
  humanQuotes: z.array(text).min(1).max(20),
});
const agreementSchema = agreementInput.omit({ agentId: true }).extend({
  id: z.uuid(),
  supervisorId: z.string(),
  leadId: z.string(),
  workspaceId: z.string(),
  humanContext: z.string(),
  recordedAt: z.iso.datetime(),
});
export const supervisorTaskInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("context"), agentId: z.string().min(1) }).strict(),
  agreementInput.extend({ action: z.literal("agreement") }).strict(),
  z
    .object({
      action: z.literal("review"),
      agentId: z.string().min(1),
      turnId: z.string().min(1),
      agreementId: z.uuid(),
      decision: z.enum(["accepted", "reopened", "needs_human"]),
      scope: z.enum(["within_agreement", "change_required"]),
      evidence: text,
      checks: z
        .array(z.object({ criterion: text, evidence: text }).strict())
        .max(20)
        .default([]),
      requestedChange: text.optional(),
    })
    .strict(),
]);
export type SupervisorTaskInput = z.infer<typeof supervisorTaskInput>;
type ReviewInput = Extract<SupervisorTaskInput, { action: "review" }>;
export interface TimelineText {
  type: string;
  text?: string;
}

export function assertReviewTarget(supervisor: Seat, target: Seat | null): asserts target is Seat {
  if (
    supervisor.role !== "supervisor" ||
    supervisor.archivedAt ||
    target?.role !== "lead" ||
    target.archivedAt ||
    !target.workspaceId ||
    target.parentId !== supervisor.id
  )
    denied("review only your assigned Lead's handback");
}

export function humanReviewContext(timeline: readonly TimelineText[]) {
  const messages = timeline.flatMap((item) => {
    if (item.type !== "user_message" || !item.text?.trim()) return [];
    const human = humanText(item.text);
    return human === null ? [] : [human];
  });
  return {
    messages,
    fingerprint: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
  };
}

export function readTaskAgreement(target: Seat) {
  const stored = target.labels[TASK_AGREEMENT_LABEL];
  return stored ? agreementSchema.parse(JSON.parse(stored)) : null;
}

/** Sup consolidates the existing conversation; recording is not a new owner approval step. */
export function createTaskAgreement(
  supervisor: Seat,
  target: Seat,
  input: z.infer<typeof agreementInput>,
  timeline: readonly TimelineText[],
) {
  assertReviewTarget(supervisor, target);
  const parsed = agreementInput.parse(input);
  const context = humanReviewContext(timeline);
  if (
    !context.messages.length ||
    !parsed.humanQuotes.every((quote) =>
      context.messages.some((message) => message.includes(quote)),
    ) ||
    !parsed.humanQuotes.some((quote) => context.messages.at(-1)!.includes(quote))
  )
    throw new Error(
      "OVERMIND_AGREEMENT_DENIED: cite actual human messages, including the latest human input",
    );
  const current = readTaskAgreement(target);
  if (
    current &&
    (current.leadId !== target.id ||
      current.workspaceId !== target.workspaceId ||
      current.supervisorId !== supervisor.id)
  )
    throw new Error(
      "OVERMIND_AGREEMENT_DENIED: agreement belongs to another Lead, workspace or Supervisor",
    );
  const waiting = target.labels["overmind.review.decision"] === "needs_human";
  if (waiting && target.labels["overmind.review.human_context"] === context.fingerprint)
    throw new Error(
      "OVERMIND_AGREEMENT_DENIED: human input is required before resolving the requested change",
    );
  if (current?.humanContext === context.fingerprint && current.supervisorId === supervisor.id) {
    if (
      current.scope !== parsed.scope ||
      JSON.stringify(current.acceptanceCriteria) !== JSON.stringify(parsed.acceptanceCriteria)
    )
      throw new Error(
        "OVERMIND_AGREEMENT_DENIED: human input is required to change the agreed scope or criteria",
      );
    return current;
  }
  if (new Set(parsed.acceptanceCriteria).size !== parsed.acceptanceCriteria.length)
    throw new Error("OVERMIND_AGREEMENT_DENIED: acceptance criteria must be distinct");
  return {
    id: randomUUID(),
    supervisorId: supervisor.id,
    leadId: target.id,
    workspaceId: target.workspaceId!,
    scope: parsed.scope,
    acceptanceCriteria: parsed.acceptanceCriteria,
    humanQuotes: parsed.humanQuotes,
    humanContext: context.fingerprint,
    recordedAt: new Date().toISOString(),
  };
}

export function supervisorReviewLabels(
  supervisor: Seat,
  target: Seat,
  input: ReviewInput,
  timeline: readonly TimelineText[],
): Record<string, string> {
  assertReviewTarget(supervisor, target);
  const agreement = readTaskAgreement(target);
  const context = humanReviewContext(timeline);
  if (
    !agreement ||
    agreement.id !== input.agreementId ||
    agreement.supervisorId !== supervisor.id ||
    agreement.leadId !== target.id ||
    agreement.workspaceId !== target.workspaceId ||
    agreement.humanContext !== context.fingerprint
  )
    throw new Error(
      "OVERMIND_AGREEMENT_DENIED: reconcile the agreement with the current human conversation first",
    );
  if (
    target.labels["overmind.review.decision"] === "needs_human" &&
    target.labels["overmind.review.agreement_id"] === agreement.id
  )
    throw new Error("OVERMIND_AGREEMENT_DENIED: the requested change still needs human input");
  if (
    (input.decision === "needs_human") !== (input.scope === "change_required") ||
    (input.decision === "needs_human" && !input.requestedChange) ||
    (input.decision !== "needs_human" && input.requestedChange)
  )
    throw new Error(
      "OVERMIND_AGREEMENT_DENIED: scope changes require human review, not acceptance",
    );
  if (
    input.decision === "accepted" &&
    (input.checks.length !== agreement.acceptanceCriteria.length ||
      new Set(input.checks.map((check) => check.criterion)).size !== input.checks.length ||
      !agreement.acceptanceCriteria.every((criterion) =>
        input.checks.some((check) => check.criterion === criterion),
      ))
  )
    throw new Error(
      "OVERMIND_AGREEMENT_DENIED: acceptance needs evidence for every agreed criterion",
    );
  return {
    "overmind.task.status": REVIEW_STATUSES.get(input.decision)!,
    "overmind.review.turn_id": input.turnId,
    "overmind.review.message_at": target.lastUserMessageAt ?? "",
    "overmind.review.decision": input.decision,
    "overmind.review.evidence": input.evidence,
    "overmind.review.at": new Date().toISOString(),
    "overmind.review.reviewer_kind": "supervisor",
    "overmind.review.reviewer_id": supervisor.id,
    "overmind.review.agreement_id": agreement.id,
    "overmind.review.scope": input.scope,
    "overmind.review.checks": JSON.stringify(input.checks),
    "overmind.review.requested_change": input.requestedChange ?? "",
    "overmind.review.human_context": context.fingerprint,
  };
}

/** Reject a review of a turn that is still running or was superseded by new input. */
export function assertReviewable(target: Seat, labels: Record<string, string>): void {
  const decision = labels["overmind.review.decision"] ?? "";
  if (
    target.status !== "idle" ||
    target.activeTurn ||
    !REVIEW_STATUSES.has(decision) ||
    !labels["overmind.review.evidence"]?.trim() ||
    target.labels["overmind.turn.outcome"] !== "completed" ||
    !labels["overmind.review.turn_id"] ||
    labels["overmind.review.turn_id"] !== target.labels["overmind.turn.id"] ||
    labels["overmind.review.message_at"] !== (target.lastUserMessageAt ?? "") ||
    labels["overmind.review.message_at"] !== (target.labels["overmind.turn.message_at"] ?? "") ||
    labels["overmind.task.status"] !== REVIEW_STATUSES.get(decision)
  )
    throw new Error(
      "OVERMIND_REVIEW_CONFLICT: task changed or is not ready for evidence-backed review",
    );
}
