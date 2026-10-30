export const TASK_STATUSES = [
  "TODO",
  "IN_PROGRESS",
  "READY_FOR_REVIEW",
  "DUAL_SEAT_REVIEW",
  "WAITING_FOR_HUMAN",
  "DONE",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export interface TaskAgentState {
  status: string;
  activeTurn?: unknown;
  lastUserMessageAt?: string | null;
  labels: Readonly<Record<string, string>>;
  /** Idle but not handed back: a child still works, or it waits on its Supervisor or a dual-seat. */
  awaiting?: boolean;
}

// Some providers never echo the prompt, so a missing timestamp is recorded as "".
function samePrompt(recorded: string | undefined, current: string | null | undefined): boolean {
  return (recorded ?? "") === (current ?? "");
}

/** A review belongs to one completed turn and the prompt that started it. */
export function reviewableTurn(agent: TaskAgentState): string | null {
  const labels = agent.labels;
  if (
    agent.status !== "idle" ||
    agent.activeTurn ||
    agent.awaiting ||
    labels["overmind.turn.outcome"] !== "completed" ||
    !samePrompt(labels["overmind.turn.message_at"], agent.lastUserMessageAt)
  )
    return null;
  return labels["overmind.turn.id"] || null;
}

export function taskStatus(agent: TaskAgentState): TaskStatus {
  const labels = agent.labels;
  if (agent.status === "running" || agent.activeTurn) return "IN_PROGRESS";
  if (labels["overmind.review.decision"] === "needs_human") return "WAITING_FOR_HUMAN";
  if (agent.awaiting) return "IN_PROGRESS";
  const turnId = reviewableTurn(agent);
  if (turnId) {
    const reviewed =
      labels["overmind.review.turn_id"] === turnId &&
      samePrompt(labels["overmind.review.message_at"], agent.lastUserMessageAt) &&
      Boolean(labels["overmind.review.evidence"]?.trim());
    if (reviewed && labels["overmind.review.decision"] === "accepted") return "DONE";
    if (reviewed && labels["overmind.review.decision"] === "reopened") return "IN_PROGRESS";
    return "READY_FOR_REVIEW";
  }
  if (agent.lastUserMessageAt && labels["overmind.turn.message_at"] !== agent.lastUserMessageAt)
    return "IN_PROGRESS";
  const status = labels["overmind.task.status"];
  if (status === "DONE" || status === "READY_FOR_REVIEW") return "READY_FOR_REVIEW";
  if (status === "DUAL_SEAT_REVIEW") return status;
  if (status === "IN_PROGRESS" || agent.status === "error") return "IN_PROGRESS";
  return "TODO";
}
