/**
 * Turn-boundary mailbox middleware.
 *
 * Inbound messages are delivered immediately while an agent is idle.  While
 * an agent is thinking or executing, messages are retained in FIFO order and
 * can only be released after an explicit idle/turn-boundary transition.  This
 * is the steering guard: callers never have to guess whether a provider is in
 * the middle of a turn.
 */

export type AgentExecutionState =
  | "IDLE"
  | "THINKING"
  | "EXECUTING"
  | "idle"
  | "thinking"
  | "executing"
  | (string & {});

export interface MailboxDecision<T> {
  /** True when the message was held instead of delivered. */
  readonly held: boolean;
  /** A message that may be passed to the agent immediately. */
  readonly delivered: readonly T[];
  /** Number of messages retained for this agent after this operation. */
  readonly queueLength: number;
}

export interface MailboxMiddlewareOptions<T> {
  /** Called after a turn boundary releases one or more messages. */
  readonly onRelease?: (agentId: string, messages: readonly T[]) => void;
}

function normalizeAgentId(agentId: string): string {
  const value = agentId.trim();
  if (value.length === 0) throw new TypeError("agentId must not be empty");
  return value;
}

function normalizeState(state: AgentExecutionState): string {
  return state.trim().toUpperCase();
}

/** Only an explicit IDLE state is safe for delivery. Unknown states fail closed. */
export function isAgentIdle(state: AgentExecutionState): boolean {
  return normalizeState(state) === "IDLE";
}

export function isAgentTurnActive(state: AgentExecutionState): boolean {
  return !isAgentIdle(state);
}

/**
 * In-memory mailbox keyed by agent id.  The class is transport-neutral so it
 * can be used from `onMessageInbound` and `onTurnBoundary` hooks alike.
 */
export class MailboxMiddleware<T = unknown> {
  private readonly states = new Map<string, string>();
  private readonly queues = new Map<string, T[]>();
  private readonly onRelease?: (agentId: string, messages: readonly T[]) => void;

  constructor(options: MailboxMiddlewareOptions<T> = {}) {
    this.onRelease = options.onRelease;
  }

  /** Return the last observed state. New agents start idle. */
  stateFor(agentId: string): string {
    return this.states.get(normalizeAgentId(agentId)) ?? "IDLE";
  }

  /** Set an agent state and release the queue only when it becomes IDLE. */
  setState(agentId: string, state: AgentExecutionState): readonly T[] {
    const id = normalizeAgentId(agentId);
    const normalized = normalizeState(state);
    this.states.set(id, normalized);
    if (normalized !== "IDLE") return [];
    return this.release(id);
  }

  /** Alias used by lifecycle integrations. */
  onAgentStateChange(agentId: string, state: AgentExecutionState): readonly T[] {
    return this.setState(agentId, state);
  }

  /**
   * Handle one inbound message against the current state.  A message is
   * delivered as a one-element array while idle, otherwise it is queued.
   */
  onMessageInbound(
    agentId: string,
    message: T,
    observedState?: AgentExecutionState,
  ): MailboxDecision<T> {
    const id = normalizeAgentId(agentId);
    const released = observedState === undefined ? [] : this.setState(id, observedState);
    if (isAgentIdle(this.stateFor(id))) {
      return {
        held: false,
        delivered: [...released, message],
        queueLength: this.pending(id),
      };
    }

    const queue = this.queues.get(id) ?? [];
    queue.push(message);
    this.queues.set(id, queue);
    return { held: true, delivered: [], queueLength: queue.length };
  }

  /** Short alias for middleware pipelines that call the operation `process`. */
  process(agentId: string, message: T, observedState?: AgentExecutionState): MailboxDecision<T> {
    return this.onMessageInbound(agentId, message, observedState);
  }

  /** Alias retained for integrations that use an enqueue-oriented name. */
  enqueue(agentId: string, message: T, observedState?: AgentExecutionState): MailboxDecision<T> {
    return this.onMessageInbound(agentId, message, observedState);
  }

  /**
   * Drain only at a turn boundary. Calling this while active is a no-op and
   * leaves the queue intact, preventing accidental mid-thought delivery.
   */
  release(agentId: string): readonly T[] {
    const id = normalizeAgentId(agentId);
    if (!isAgentIdle(this.stateFor(id))) return [];
    const queue = this.queues.get(id);
    if (!queue || queue.length === 0) return [];

    this.queues.delete(id);
    const messages = queue.slice();
    this.onRelease?.(id, messages);
    return messages;
  }

  /** Explicit turn-boundary hook. */
  onTurnBoundary(agentId: string): readonly T[] {
    this.states.set(normalizeAgentId(agentId), "IDLE");
    return this.release(agentId);
  }

  /** Number of messages currently retained for an agent. */
  pending(agentId: string): number {
    return this.queues.get(normalizeAgentId(agentId))?.length ?? 0;
  }

  /** Snapshot pending messages without releasing them. */
  peek(agentId: string): readonly T[] {
    return [...(this.queues.get(normalizeAgentId(agentId)) ?? [])];
  }

  /** Remove retained messages, useful when an agent closes. */
  clear(agentId: string): void {
    const id = normalizeAgentId(agentId);
    this.queues.delete(id);
    this.states.delete(id);
  }

  clearAll(): void {
    this.queues.clear();
    this.states.clear();
  }
}

/** More descriptive name for callers that treat the mailbox as a guard. */
export const TurnBoundaryMailbox = MailboxMiddleware;
export const MailboxQueueMiddleware = MailboxMiddleware;
export const SteeringGuardMiddleware = MailboxMiddleware;

export function createMailboxMiddleware<T = unknown>(
  options: MailboxMiddlewareOptions<T> = {},
): MailboxMiddleware<T> {
  return new MailboxMiddleware(options);
}

export default MailboxMiddleware;
