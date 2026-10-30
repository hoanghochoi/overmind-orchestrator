import { randomUUID } from "node:crypto";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { roleForProvider, type ProfileRole } from "../shared/providers.js";
import { assertContractLocked } from "./contract.js";
import type { SeatStore } from "./seat-store.js";

export type Role = ProfileRole;
export const NEXT_ROLE: Partial<Record<Role, Role>> = { supervisor: "lead", lead: "peer" };

/** A live agent with the plugin-owned Overmind labels laid over its own. */
export interface Seat {
  id: string;
  provider: string;
  role: Role | null;
  title: string | null;
  cwd: string;
  workspaceId: string | undefined;
  parentId: string | null;
  labels: Record<string, string>;
  status: string;
  activeTurn: unknown;
  lastUserMessageAt: string | null;
  archivedAt: string | null;
}

export function seatFrom(agent: PaseoAgent, overlay: Record<string, string>): Seat {
  return {
    id: agent.id,
    provider: agent.provider,
    role: roleForProvider(agent.provider),
    title: agent.title,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    parentId: getParentAgentIdFromLabels(agent.labels) ?? null,
    labels: { ...agent.labels, ...overlay },
    status: agent.status,
    activeTurn: agent.activeTurn ?? null,
    lastUserMessageAt: agent.lastUserMessageAt,
    archivedAt: agent.archivedAt ?? null,
  };
}

export async function loadSeat(
  paseo: PaseoApi,
  seats: SeatStore,
  agentId: string,
): Promise<Seat | null> {
  const current = await paseo.agents.ref(agentId).refresh();
  return current ? seatFrom(current.agent, await seats.get(agentId)) : null;
}

export function denied(reason: string): never {
  throw new Error(`OVERMIND_ROLE_DENIED: ${reason}`);
}

/** Supervisor reaches any Lead; a Lead reaches only its own Peers in its workspace. */
export function assertTarget(
  caller: Seat,
  tool: string,
  target: Seat | null,
): asserts target is Seat {
  const role = caller.role;
  const expected = role ? NEXT_ROLE[role] : undefined;
  const ownershipRequired = role === "lead" || tool === "archive_agent";
  if (
    !target ||
    !expected ||
    target.role !== expected ||
    target.archivedAt ||
    (ownershipRequired && target.parentId !== caller.id) ||
    (role === "lead" && target.workspaceId !== caller.workspaceId)
  )
    denied("target role, ownership or workspace is outside your authority");
}

/** A Lead waiting for a Human scope decision accepts no new work for itself or its Peers. */
export function assertScopeDispatch(lead: Seat): void {
  if (lead.labels["overmind.review.decision"] === "needs_human")
    throw new Error(
      "OVERMIND_SCOPE_WAITING_HUMAN: the requested scope change requires Human input",
    );
}

const TEST_INTENT =
  /\btdd\b|\b(?:write|generate|create|add|implement|mint|build|author)\b[^\n.!?]{0,120}\b(?:tests?|testing|specs?)\b|(?:viết|tạo|sinh|thêm|bổ sung)[^\n.!?]{0,120}(?:\btests?\b|kiểm\s+thử)/i;
const NEGATED = /\b(?:do not|don't|never|must not|cannot)\b[^\n.!?]*|(?:không|đừng)[^\n.!?]*/gi;

/**
 * Test generation for a Peer needs its Lead's current contract lock. Returns true
 * when the task is test generation so the caller can mark the Peer.
 */
export async function assertPeerTask(
  peerLabels: Record<string, string>,
  lead: Seat,
  prompt: string,
): Promise<boolean> {
  // shortcut: free-form intent is heuristic; label the task explicitly for other languages.
  const testTask =
    peerLabels["overmind.task.kind"] === "test-generation" ||
    TEST_INTENT.test(prompt.replace(NEGATED, ""));
  if (!testTask) return false;
  await assertContractLocked(lead);
  return true;
}

const TICKET_TTL_MS = 120_000;

/**
 * One-time creation tickets. The agent.create hook cannot see the requested parent,
 * so a Lead or Peer is created only with a ticket issued for the authorized parent.
 */
export class CreationTickets {
  private readonly tickets = new Map<string, { role: Role; parentId: string; expires: number }>();

  issue(role: Role, parentId: string): string {
    const now = Date.now();
    for (const [id, ticket] of this.tickets) if (ticket.expires < now) this.tickets.delete(id);
    const id = randomUUID();
    this.tickets.set(id, { role, parentId, expires: now + TICKET_TTL_MS });
    return id;
  }

  consume(id: string | undefined, role: Role): boolean {
    const ticket = id ? this.tickets.get(id) : undefined;
    if (!ticket) return false;
    this.tickets.delete(id!);
    return ticket.role === role && ticket.expires >= Date.now();
  }
}

export const CREATION_TICKET_ENV = "OVERMIND_CREATION_TICKET";
