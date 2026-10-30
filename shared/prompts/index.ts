import type { OvermindRole, RoleShortName } from "../modules/skills_engine.js";
import { LEAD_PROMPT, LEAD_HIERARCHY } from "./lead.js";
import { PEER_PROMPT, PEER_HIERARCHY } from "./peer.js";
import { SUPERVISOR_PROMPT, SUPERVISOR_HIERARCHY } from "./supervisor.js";
export { OVERMIND_LAW_0, OVERMIND_LAW_2, OVERMIND_LAW_3 } from "./law.js";

export { LEAD_PROMPT } from "./lead.js";
export { PEER_PROMPT } from "./peer.js";
export { SUPERVISOR_PROMPT } from "./supervisor.js";

function canonicalRole(role: OvermindRole | RoleShortName): OvermindRole {
  if (role === "S") return "supervisor";
  if (role === "L") return "lead";
  if (role === "P") return "peer";
  return role;
}

export function promptForRole(role: OvermindRole | RoleShortName): string {
  switch (canonicalRole(role)) {
    case "supervisor":
      return `${SUPERVISOR_PROMPT}\n\n${SUPERVISOR_HIERARCHY}`;
    case "lead":
      return `${LEAD_PROMPT}\n\n${LEAD_HIERARCHY}`;
    case "peer":
      return `${PEER_PROMPT}\n\n${PEER_HIERARCHY}`;
  }
}
