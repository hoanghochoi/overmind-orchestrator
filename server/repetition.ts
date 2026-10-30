import { z } from "zod";
import type { SeatStore } from "./seat-store.js";

/** Consecutive turns with the same anti-pattern before the approach must change. */
export const REPEAT_LIMIT = 3;
export const ESCALATED_LABEL = "overmind.repeat.escalated";
const PREFIX = "overmind.repeat.";
const evidenceSchema = z.array(z.object({ turnId: z.string().nullable(), excerpt: z.string() }));
export type RepeatEvidence = z.infer<typeof evidenceSchema>;

export interface Escalation {
  antiPattern: string;
  count: number;
  evidence: RepeatEvidence;
}

function counterKey(antiPattern: string) {
  return `${PREFIX}${antiPattern}`;
}
function evidenceKey(antiPattern: string) {
  return `${PREFIX}${antiPattern}.evidence`;
}
function parseEvidence(text: string | undefined): RepeatEvidence {
  try {
    return evidenceSchema.parse(JSON.parse(text ?? "[]"));
  } catch {
    return [];
  }
}
export function escalatedAntiPatterns(labels: Readonly<Record<string, string>>): string[] {
  return (labels[ESCALATED_LABEL] ?? "").split(",").filter(Boolean);
}

/**
 * Counts consecutive assessed turns per anti-pattern. A turn without the anti-pattern
 * is progress and resets its count; reaching the limit escalates once per streak, and
 * the escalation stays open until a new approach is dispatched.
 */
export class RepetitionTracker {
  constructor(private readonly seats: SeatStore) {}

  async observe(
    agentId: string,
    turnId: string | null,
    found: ReadonlyMap<string, string>,
  ): Promise<Escalation[]> {
    const labels = await this.seats.get(agentId);
    const open = new Set(escalatedAntiPatterns(labels));
    const updates: Record<string, string> = {};
    const escalations: Escalation[] = [];
    const tracked = Object.keys(labels)
      .filter(
        (key) => key.startsWith(PREFIX) && key !== ESCALATED_LABEL && !key.endsWith(".evidence"),
      )
      .map((key) => key.slice(PREFIX.length));
    for (const antiPattern of tracked)
      if (!found.has(antiPattern)) {
        updates[counterKey(antiPattern)] = "";
        updates[evidenceKey(antiPattern)] = "";
        open.delete(antiPattern);
      }
    for (const [antiPattern, excerpt] of found) {
      const count = Number(labels[counterKey(antiPattern)] ?? 0) + 1;
      const evidence = [
        ...parseEvidence(labels[evidenceKey(antiPattern)]),
        { turnId, excerpt: excerpt.slice(-300) },
      ].slice(-REPEAT_LIMIT);
      updates[counterKey(antiPattern)] = String(count);
      updates[evidenceKey(antiPattern)] = JSON.stringify(evidence);
      if (count >= REPEAT_LIMIT && !open.has(antiPattern)) {
        open.add(antiPattern);
        escalations.push({ antiPattern, count, evidence });
      }
    }
    updates[ESCALATED_LABEL] = [...open].join(",");
    await this.seats.merge(agentId, updates);
    return escalations;
  }

  /** A stated new approach closes the escalation and gives it a fresh budget. */
  async redirect(agentId: string): Promise<void> {
    const labels = await this.seats.get(agentId);
    const updates: Record<string, string> = { [ESCALATED_LABEL]: "" };
    for (const antiPattern of escalatedAntiPatterns(labels)) {
      updates[counterKey(antiPattern)] = "";
      updates[evidenceKey(antiPattern)] = "";
    }
    await this.seats.merge(agentId, updates);
  }
}
