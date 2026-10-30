/**
 * Communication contract for messages exchanged between Overmind roles.
 * Role messages carry evidence and decisions, never a person's attributed
 * intent or a relayed upstream prompt.
 */
const HUMAN_REFERENCE_PATTERN =
  /\b(?:human|humans|user|users|customer|customers|client|clients|operator|operators|people|person|end[-\s]?user)\b|người\s+dùng|con\s+người/i;

export function containsHumanReference(value: string): boolean {
  return HUMAN_REFERENCE_PATTERN.test(value);
}

/**
 * Fail closed before a notification is delivered to another role. Redaction
 * would hide provenance and could change the meaning of the evidence, so the
 * caller must rewrite the message in role-neutral terms.
 */
export function assertInterRoleMessage(value: string, field = "message"): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Inter-role ${field} must not be empty`);
  }
  if (containsHumanReference(value)) {
    throw new Error(
      `Inter-role ${field} blocked: remove person-attributed intent and relay only objective, evidence, contracts, risks, or acceptance criteria`,
    );
  }
}
