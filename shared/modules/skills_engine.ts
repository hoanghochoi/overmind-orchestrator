import { MailboxMiddleware } from "../middleware/mailbox.js";
import { OVERMIND_LAW_0, OVERMIND_LAW_2, OVERMIND_LAW_3, promptForRole } from "../prompts/index.js";

/** Role-isolated skill policy and governance guards for Overmind.
 *
 * The lifecycle integration applies this policy to role homes and launch
 * environment; the Overmind MCP server enforces tool authority per call.
 */

export type OvermindRole = "supervisor" | "lead" | "peer";
export type RoleShortName = "S" | "L" | "P";

/** Tools of the plugin's `overmind` MCP server shared by Supervisor and Lead. */
export const OVERMIND_COORDINATION_TOOLS = Object.freeze([
  "list_agents",
  "get_agent_status",
  "get_agent_activity",
  "list_workspaces",
  "list_providers",
  "list_models",
  "create_agent",
  "send_agent_prompt",
  "archive_agent",
]);

export interface SkillPolicy {
  readonly allowed_skills: readonly string[];
  readonly denied_skills: readonly string[];
}

export interface RoleSkillMatrix {
  readonly supervisor: SkillPolicy;
  readonly lead: SkillPolicy;
  readonly peer: SkillPolicy;
}

const PEER_EXTERNAL_SEARCH_DENY = Object.freeze([
  "websearch",
  "web_search",
  "web-search",
  "webfetch",
  "web_fetch",
  "web-fetch",
  "browser_search",
  "browser_search:*",
  "browser:websearch",
  "browser:webfetch",
  "browser:web*",
  "search:web",
  "search:web:*",
  "internet:*",
  "internet_search",
  "internet-search:*",
  "external-search:*",
  "external_search:*",
]);

/** Defaults from PLUGIN_SPEC-v3. Deny rules always win over allow rules. */
export const DEFAULT_ROLE_SKILL_MATRIX: RoleSkillMatrix = Object.freeze({
  supervisor: Object.freeze({
    allowed_skills: [
      "sensor:*",
      "jev_evaluator",
      "causal_notebook",
      "causal_notebook_*",
      "overmind_task_review",
      "custom_arch_checker",
      "github_repo_inspector",
      ...OVERMIND_COORDINATION_TOOLS,
    ],
    denied_skills: [
      "file_writer",
      "code_editor",
      "git_commit",
      "terminal_exec",
      "native_subagent_spawn",
    ],
  }),
  lead: Object.freeze({
    allowed_skills: [
      "workspace:*",
      "contract_lock",
      "dual_seat",
      "compact",
      "hand_off",
      "custom_jira_sync",
      "custom_architecture_diagrammer",
      ...OVERMIND_COORDINATION_TOOLS,
    ],
    denied_skills: [
      "heavy_code_writer",
      "overmind_task_review",
      "native_subagent_spawn",
      "causal_notebook",
      "causal_notebook_*",
    ],
  }),
  peer: Object.freeze({
    // Every installed skill except coordination and web search.
    allowed_skills: ["*"],
    denied_skills: [
      "agent_manager",
      "overmind_task_review",
      "room_provisioner",
      "supervisor_interrupt",
      "native_subagent_spawn",
      "causal_notebook",
      "causal_notebook_*",
      ...PEER_EXTERNAL_SEARCH_DENY,
      "orchestrat*",
      // Paseo's own skills drive agents through the CLI, outside the Overmind tools.
      "paseo*",
      "room*",
      "create_agent",
      "send_agent_prompt",
      "create_workspace",
    ],
  }),
});

export interface RoleOverlay {
  readonly role: OvermindRole;
  readonly allowed_skills: readonly string[];
  readonly denied_skills: readonly string[];
  /** Paseo owns orchestration; provider-native spawning remains disabled. */
  readonly multi_agent_version: "paseo" | "disabled";
}

function roleName(role: OvermindRole | RoleShortName): OvermindRole {
  switch (role) {
    case "S":
      return "supervisor";
    case "L":
      return "lead";
    case "P":
      return "peer";
    default:
      return role;
  }
}

function normalizeSkill(skill: string): string {
  return skill.trim().toLowerCase();
}

/** Matches a policy glob. Only `*` is supported; this prevents accidental
 * regex interpretation of local skill names while retaining `sensor:*` style
 * policies from the spec.
 */
export function skillPatternMatches(pattern: string, skill: string): boolean {
  const normalizedPattern = normalizeSkill(pattern);
  const normalizedSkill = normalizeSkill(skill);
  if (!normalizedPattern) return false;
  if (normalizedPattern === "*") return true;
  const star = normalizedPattern.indexOf("*");
  if (star < 0) return normalizedPattern === normalizedSkill;
  const prefix = normalizedPattern.slice(0, star);
  const suffix = normalizedPattern.slice(star + 1);
  return normalizedSkill.startsWith(prefix) && normalizedSkill.endsWith(suffix);
}

function matchesAny(patterns: readonly string[], skill: string): boolean {
  return patterns.some((pattern) => skillPatternMatches(pattern, skill));
}

const NATIVE_SUBAGENT_SKILL = "native_subagent_spawn";

function enforceGlobalDeny(role: OvermindRole, policy: SkillPolicy): SkillPolicy {
  const denied_skills = policy.denied_skills.some((pattern) =>
    skillPatternMatches(pattern, NATIVE_SUBAGENT_SKILL),
  )
    ? [...policy.denied_skills]
    : [...policy.denied_skills, NATIVE_SUBAGENT_SKILL];
  if (role !== "supervisor") denied_skills.push("causal_notebook", "causal_notebook_*");
  if (role === "peer") {
    for (const pattern of PEER_EXTERNAL_SEARCH_DENY) {
      if (!denied_skills.some((existing) => skillPatternMatches(existing, pattern))) {
        denied_skills.push(pattern);
      }
    }
  }
  return Object.freeze({
    allowed_skills: Object.freeze([...policy.allowed_skills]),
    denied_skills: Object.freeze(denied_skills),
  });
}

/**
 * Applies an allow/deny policy to a discovered skill list.  Deny precedence
 * makes a broad allow (`*`) safe to combine with narrow deny rules.
 */
export type RoleSkillMatrixInput = Partial<RoleSkillMatrix> &
  Partial<Record<RoleShortName, SkillPolicy>>;

export class SkillFilteringEngine {
  readonly matrix: RoleSkillMatrix;

  constructor(matrix: RoleSkillMatrixInput = {}) {
    this.matrix = Object.freeze({
      supervisor: enforceGlobalDeny(
        "supervisor",
        matrix.supervisor ?? matrix.S ?? DEFAULT_ROLE_SKILL_MATRIX.supervisor,
      ),
      lead: enforceGlobalDeny("lead", matrix.lead ?? matrix.L ?? DEFAULT_ROLE_SKILL_MATRIX.lead),
      peer: enforceGlobalDeny("peer", matrix.peer ?? matrix.P ?? DEFAULT_ROLE_SKILL_MATRIX.peer),
    });
  }

  policyFor(role: OvermindRole | RoleShortName): SkillPolicy {
    return this.matrix[roleName(role)];
  }

  isAllowed(role: OvermindRole | RoleShortName, skill: string): boolean {
    const policy = this.policyFor(role);
    if (matchesAny(policy.denied_skills, skill)) return false;
    return matchesAny(policy.allowed_skills, skill);
  }

  filter(role: OvermindRole | RoleShortName, discoveredSkills: readonly string[]): string[] {
    return discoveredSkills.filter((skill) => this.isAllowed(role, skill));
  }

  /** Throws instead of silently widening a role's capability set. */
  assertAllowed(role: OvermindRole | RoleShortName, skill: string): void {
    if (!this.isAllowed(role, skill)) {
      throw new Error(`Overmind skill denied for ${roleName(role)}: ${skill}`);
    }
  }

  overlay(role: OvermindRole | RoleShortName): RoleOverlay {
    const resolved = roleName(role);
    const policy = this.policyFor(resolved);
    return {
      role: resolved,
      allowed_skills: [...policy.allowed_skills],
      denied_skills: [...policy.denied_skills],
      multi_agent_version: resolved === "peer" ? "disabled" : "paseo",
    };
  }

  nativeSubagentsEnabled(role: OvermindRole | RoleShortName): boolean {
    void role;
    return false;
  }
}

export interface ContractLockState {
  readonly databaseSchemaLocked: boolean;
  readonly apiContractLocked: boolean;
  readonly lockedAt?: string;
  readonly schemaFingerprint?: string;
  readonly apiFingerprint?: string;
}

export interface ContractLockInput {
  readonly schemaFingerprint?: string;
  readonly apiFingerprint?: string;
  readonly at?: string;
}

/**
 * Anti-Minting API guard. Peer tests may only be generated after both the DB
 * schema and API contract have been explicitly locked by a Lead.
 */
export class ContractLock {
  private stateValue: ContractLockState = {
    databaseSchemaLocked: false,
    apiContractLocked: false,
  };

  get state(): ContractLockState {
    return { ...this.stateValue };
  }

  lockDatabaseSchema(input: ContractLockInput = {}): ContractLockState {
    this.stateValue = {
      ...this.stateValue,
      databaseSchemaLocked: true,
      lockedAt: input.at ?? this.stateValue.lockedAt ?? new Date().toISOString(),
      ...(input.schemaFingerprint ? { schemaFingerprint: input.schemaFingerprint } : {}),
    };
    return this.state;
  }

  /** Alias for callers that use the shorter schema terminology. */
  lockSchema(input: ContractLockInput = {}): ContractLockState {
    return this.lockDatabaseSchema(input);
  }

  /** Alias for callers that use the shorter contract terminology. */
  lockApi(input: ContractLockInput = {}): ContractLockState {
    return this.lockApiContract(input);
  }

  lockApiContract(input: ContractLockInput = {}): ContractLockState {
    this.stateValue = {
      ...this.stateValue,
      apiContractLocked: true,
      lockedAt: input.at ?? this.stateValue.lockedAt ?? new Date().toISOString(),
      ...(input.apiFingerprint ? { apiFingerprint: input.apiFingerprint } : {}),
    };
    return this.state;
  }

  unlock(): void {
    this.stateValue = { databaseSchemaLocked: false, apiContractLocked: false };
  }

  canGeneratePeerTests(): boolean {
    return this.stateValue.databaseSchemaLocked && this.stateValue.apiContractLocked;
  }

  assertPeerTestGenerationAllowed(): void {
    const missing: string[] = [];
    if (!this.stateValue.databaseSchemaLocked) missing.push("database schema");
    if (!this.stateValue.apiContractLocked) missing.push("API contract");
    if (missing.length > 0) {
      throw new Error(
        `Anti-Minting API rule: lock ${missing.join(" and ")} before generating peer tests`,
      );
    }
  }
}

/** Catches a brief that would have a Peer mint tests before contracts exist. */
export function isLikelyTestGenerationRequest(objective: string): boolean {
  return /\b(?:test|tests|testing|tdd)\b/i.test(objective);
}

export interface PushbackProtocol {
  readonly required: true;
  readonly instruction: string;
}

export const PEER_PUSHBACK_PROTOCOL: PushbackProtocol = Object.freeze({
  required: true,
  instruction:
    "Pushback Protocol: independently test the Lead framing. If assumptions, scope, or evidence are wrong, say so clearly. Return Option A (accept), Option B (bounded correction), or Option C (reject framing and propose a safer alternative) with evidence and acceptance criteria.",
});

/**
 * Backwards-compatible matrix used by package entrypoints. The long role names
 * are canonical; S/L/P aliases mirror the spec's compact notation.
 */
export const DEFAULT_ROLE_SKILLS = Object.freeze({
  ...DEFAULT_ROLE_SKILL_MATRIX,
  S: DEFAULT_ROLE_SKILL_MATRIX.supervisor,
  L: DEFAULT_ROLE_SKILL_MATRIX.lead,
  P: DEFAULT_ROLE_SKILL_MATRIX.peer,
});

/**
 * Small runtime state holder for lifecycle integrations. It intentionally only
 * tracks turn ownership; Paseo exposes no generic inbound-message hook to send
 * messages from here, so no synthetic transport is created.
 */
export class OvermindRuntime {
  readonly skillMatrix: RoleSkillMatrix;
  readonly mailbox = new MailboxMiddleware<unknown>();
  private readonly activeTurns = new Set<string>();

  constructor(options: { skillMatrix?: RoleSkillMatrix } = {}) {
    this.skillMatrix = options.skillMatrix ?? DEFAULT_ROLE_SKILL_MATRIX;
  }

  beginTurn(agentId: string): void {
    const id = agentId.trim();
    if (id) {
      this.activeTurns.add(id);
      this.mailbox.setState(id, "THINKING");
    }
  }

  endTurn(agentId: string): void {
    const id = agentId.trim();
    this.activeTurns.delete(id);
    if (id) this.mailbox.onTurnBoundary(id);
  }

  close(agentId: string): void {
    const id = agentId.trim();
    this.activeTurns.delete(id);
    if (id) this.mailbox.clear(id);
  }

  isTurnActive(agentId: string): boolean {
    return this.activeTurns.has(agentId.trim());
  }

  dispose(): void {
    this.activeTurns.clear();
    this.mailbox.clearAll();
  }
}

/** Role overlay text for Paseo's supported `agent.create` before hook. */
export function rolePrompt(role: OvermindRole | RoleShortName): string {
  const resolved = roleName(role);
  const policy = new SkillFilteringEngine(DEFAULT_ROLE_SKILL_MATRIX).overlay(resolved);
  const lines = [
    OVERMIND_LAW_0,
    OVERMIND_LAW_2,
    promptForRole(resolved),
    "",
    `Overmind role: ${resolved}.`,
    `Allowed skills: ${policy.allowed_skills.join(", ") || "none"}.`,
    `Denied skills: ${policy.denied_skills.join(", ") || "none"}.`,
  ];
  lines.push(
    `multi_agent_version = '${policy.multi_agent_version}'; use Paseo agents only; provider-native sub-agents remain disabled.`,
  );
  if (resolved === "lead") {
    lines.push(
      "Anti-Minting API rule: lock the DB schema and API contract before authorizing Peer tests.",
    );
  }
  if (resolved === "peer") lines.push(OVERMIND_LAW_3, PEER_PUSHBACK_PROTOCOL.instruction);
  return lines.join("\n");
}

// Descriptive aliases used by integrations and tests that prefer verb-oriented names.
export function isSkillAllowed(
  engine: SkillFilteringEngine,
  role: OvermindRole | RoleShortName,
  skill: string,
): boolean {
  return engine.isAllowed(role, skill);
}

export function filterSkills(
  engine: SkillFilteringEngine,
  role: OvermindRole | RoleShortName,
  discoveredSkills: readonly string[],
): string[] {
  return engine.filter(role, discoveredSkills);
}
/** Capability matrix type aliases retained for integrations using S/L/P names. */
export type RoleCapabilityMatrix = RoleSkillMatrix;
