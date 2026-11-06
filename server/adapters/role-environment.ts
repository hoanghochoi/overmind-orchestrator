import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";
import type {
  DriverRole,
  RoleEnvironment,
  RoleEnvironmentOptions,
} from "./interface.js";
import { SkillFilteringEngine } from "../../shared/modules/skills_engine.js";
import { promptForRole } from "../../shared/prompts/index.js";

interface RolePolicy {
  readonly sandboxMode?: "read-only" | "workspace-write";
  readonly homeDirectory: string;
  readonly baselineConfigPath: string;
  readonly environmentKeys: readonly string[];
}

const ROLE_NAMES = new Set<DriverRole>(["supervisor", "lead", "peer"]);
/**
 * MCP servers a read-only Supervisor or a Peer keeps from the owner's config. Every other
 * server (cloud consoles, deploy tools) would act outside the sandbox, which never
 * covers MCP calls. The Overmind servers arrive per agent, not through this file.
 */
const ROLE_MCP_SERVERS = new Set(["codegraph", "node_repl"]);

function assertRole(role: DriverRole): void {
  if (!ROLE_NAMES.has(role))
    throw new RangeError(`Unsupported Overmind role: ${String(role)}`);
}

function sandboxModeForRole(role: DriverRole): RolePolicy["sandboxMode"] {
  if (role === "supervisor") return "read-only";
  // The Peer implements: it writes and reaches the network, only web search is denied.
  if (role === "peer") return "workspace-write";
  return undefined;
}

function rolePolicy(
  driverName: string,
  role: DriverRole,
  root: string
): RolePolicy {
  const driver = driverName.trim().toLowerCase();
  switch (driver) {
    case "codex": {
      const providerRoot = join(root, ".codex");
      return {
        sandboxMode: sandboxModeForRole(role),
        homeDirectory: join(providerRoot, "roles", role),
        baselineConfigPath: join(providerRoot, "config.toml"),
        environmentKeys: ["CODEX_HOME"],
      };
    }
    case "claude": {
      const providerRoot = join(root, ".claude");
      return {
        sandboxMode: sandboxModeForRole(role),
        homeDirectory: join(providerRoot, "roles", role),
        baselineConfigPath: join(providerRoot, "config.toml"),
        environmentKeys: ["CLAUDE_CONFIG_DIR"],
      };
    }
    case "opencode": {
      const providerRoot = join(root, ".config", "opencode");
      return {
        sandboxMode: sandboxModeForRole(role),
        homeDirectory: join(providerRoot, "roles", role),
        baselineConfigPath: join(providerRoot, "config.toml"),
        // A config dir replaces the owner's, dropping its providers and models; the role
        // limits travel as OPENCODE_CONFIG_CONTENT, which OpenCode merges over that config.
        environmentKeys: [],
      };
    }
    case "pi": {
      const providerRoot = join(root, ".pi", "agent");
      return {
        sandboxMode: sandboxModeForRole(role),
        homeDirectory: join(providerRoot, "roles", role),
        baselineConfigPath: join(providerRoot, "config.toml"),
        environmentKeys: ["PI_CODING_AGENT_DIR"],
      };
    }
    case "agy":
    case "antigravity": {
      const providerRoot = join(root, ".gemini", "antigravity-cli");
      return {
        sandboxMode: sandboxModeForRole(role),
        homeDirectory: join(providerRoot, "roles", role),
        baselineConfigPath: join(providerRoot, "config.toml"),
        // AGY has no documented config-dir override; HOME/USERPROFILE provide
        // the physical boundary while the vendor-specific keys cover CLIs that
        // do honor them.
        environmentKeys: [
          "GEMINI_HOME",
          "GEMINI_CLI_HOME",
          "HOME",
          "USERPROFILE",
        ],
      };
    }
    default: {
      const providerRoot = join(root, ".overmind");
      return {
        sandboxMode: sandboxModeForRole(role),
        homeDirectory: join(providerRoot, "roles", role),
        baselineConfigPath: join(providerRoot, "config.toml"),
        environmentKeys: ["OVERMIND_HOME"],
      };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeToml(
  base: TomlTable,
  overlay: Record<string, unknown>
): TomlTable {
  const merged: TomlTable = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key];
    merged[key] =
      isRecord(previous) && isRecord(value)
        ? mergeToml(previous as TomlTable, value)
        : (value as TomlValue);
  }
  return merged;
}

function applyRoleMcpServers(
  merged: TomlTable,
  driverName: string,
  role: DriverRole,
  roleOverlay: Readonly<Record<string, unknown>> | undefined
): void {
  const overlayServers = roleOverlay?.mcp_servers;
  const wake =
    driverName.trim().toLowerCase() === "codex" &&
    role === "supervisor" &&
    isRecord(overlayServers) &&
    isRecord(overlayServers.overmind_wake)
      ? overlayServers.overmind_wake
      : null;
  if (role !== "lead" && isRecord(merged.mcp_servers)) {
    for (const name of Object.keys(merged.mcp_servers)) {
      if (!ROLE_MCP_SERVERS.has(name) && !(wake && name === "overmind_wake"))
        delete merged.mcp_servers[name];
    }
  }
  if (wake && isRecord(merged.mcp_servers))
    merged.mcp_servers.overmind_wake = wake as TomlValue;
}

/** Provider failures must surface to Overmind so its sensor can route recovery. */
function disableProviderRetries(merged: TomlTable): void {
  const providerName = merged.model_provider;
  if (typeof providerName !== "string" || !isRecord(merged.model_providers))
    return;
  const provider = merged.model_providers[providerName];
  if (!isRecord(provider)) return;
  provider.request_max_retries = 0;
  provider.stream_max_retries = 0;
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function enforcedOverlay(
  driverName: string,
  role: DriverRole,
  sandboxMode?: RolePolicy["sandboxMode"]
): Record<string, unknown> {
  const driver = driverName.trim().toLowerCase();
  const providerKnown = [
    "codex",
    "claude",
    "opencode",
    "pi",
    "agy",
    "antigravity",
  ].includes(driver);
  const providerOverlay: Record<string, unknown> = {
    ...(sandboxMode ? { sandbox_mode: sandboxMode } : {}),
    ...(role === "peer"
      ? {
          web_search: "disabled",
          sandbox_workspace_write: { network_access: true },
        }
      : {}),
    agents: { enabled: false },
    features: {
      multi_agent: false,
      multi_agent_v2: false,
      ...(role === "supervisor" ? { memories: true } : {}),
    },
  };
  return {
    memory: { causal_notebook: role === "supervisor" },
    ...(providerKnown
      ? {}
      : { multi_agent_version: role === "peer" ? "disabled" : "paseo" }),
    ...(providerKnown ? providerOverlay : {}),
    overmind: {
      role,
      agents_enabled: role !== "peer",
      multi_agent_version: role === "peer" ? "disabled" : "paseo",
      websearch_enabled: role !== "peer",
      ...(sandboxMode ? { sandbox_mode: sandboxMode } : {}),
    },
  };
}

export function roleEnvironment(
  driverName: string,
  role: DriverRole,
  options: RoleEnvironmentOptions = {}
): RoleEnvironment {
  assertRole(role);
  const root = resolve(options.homeDirectory ?? homedir());
  const policy = rolePolicy(driverName, role, root);
  const configPath = join(policy.homeDirectory, "config.toml");
  const env: Record<string, string> = {
    OVERMIND_ROLE: role,
    OVERMIND_ROLE_HOME: policy.homeDirectory,
    OVERMIND_SANDBOX_MODE: policy.sandboxMode ?? "provider-default",
    "memory.causal_notebook": String(role === "supervisor"),
    OVERMIND_AGENTS_ENABLED: role === "peer" ? "false" : "true",
    OVERMIND_MULTI_AGENT_VERSION: role === "peer" ? "disabled" : "paseo",
    OVERMIND_MODEL_CATALOG_MULTI_AGENT_VERSION:
      role === "peer" ? "disabled" : "paseo",
    OVERMIND_WEBSEARCH_ENABLED: role === "peer" ? "false" : "true",
  };
  for (const key of policy.environmentKeys) env[key] = policy.homeDirectory;
  return { role, roleHome: policy.homeDirectory, configPath, env };
}

async function readRoleBaseline(paths: readonly string[]): Promise<TomlTable> {
  let baseline: TomlTable = {};
  for (const sourcePath of new Set(paths)) {
    if (!(await readable(sourcePath))) continue;
    const source = await readFile(sourcePath, "utf8");
    try {
      baseline = mergeToml(baseline, parse(source) as TomlTable);
    } catch (error) {
      throw new Error(
        `Unable to parse role baseline TOML '${sourcePath}': ${String(error)}`,
        {
          cause: error,
        }
      );
    }
  }
  return baseline;
}

async function collectDisabledCodexSkills(
  root: string,
  roleHome: string,
  role: DriverRole,
  cwd?: string
): Promise<Array<{ path: string; enabled: boolean }>> {
  const directories = new Set([
    join(root, ".agents", "skills"),
    join(root, ".codex", "skills"),
    join(roleHome, "skills"),
  ]);
  let ancestor = cwd ? resolve(cwd) : undefined;
  while (ancestor) {
    directories.add(join(ancestor, ".agents", "skills"));
    directories.add(join(ancestor, ".codex", "skills"));
    const parent = dirname(ancestor);
    ancestor = parent === ancestor ? undefined : parent;
  }

  const disabled: Array<{ path: string; enabled: boolean }> = [];
  const engine = new SkillFilteringEngine();
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      }
    );
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillPath = join(directory, entry.name, "SKILL.md");
      const content = await readFile(skillPath, "utf8").catch(
        (error: unknown) => {
          if (isMissing(error)) return null;
          throw error;
        }
      );
      if (!content) continue;
      const name =
        /^name:\s*["']?([^\r\n"']+)/mu.exec(content)?.[1]?.trim() ?? entry.name;
      if (engine.filter(role, [name]).length === 0) {
        disabled.push({ path: skillPath, enabled: false });
      }
    }
  }
  return disabled;
}

function mergeDisabledSkillConfig(
  merged: TomlTable,
  owner: TomlTable,
  disabled: readonly { path: string; enabled: boolean }[]
): void {
  const skills = isRecord(merged.skills) ? merged.skills : {};
  // Only the owner's entries carry over; generated ones from an earlier launch would
  // keep a skill disabled after the role's allowlist widens.
  const ownerSkills = isRecord(owner.skills) ? owner.skills : {};
  const configured = Array.isArray(ownerSkills.config)
    ? ownerSkills.config
    : [];
  const byPath = new Map<string, TomlValue>();
  for (const entry of [...configured, ...disabled]) {
    if (isRecord(entry) && typeof entry.path === "string") {
      byPath.set(entry.path, entry as TomlValue);
    }
  }
  merged.skills = { ...skills, config: [...byPath.values()] } as TomlValue;
}

async function writeRoleConfig(
  configPath: string,
  merged: TomlTable
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${stringify(merged)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, configPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Creates the role home before provider launch and writes a merged TOML file.
 * The mandatory role values are applied last so a baseline cannot widen a seat.
 */
export async function prepareRoleEnvironment(
  driverName: string,
  role: DriverRole,
  options: RoleEnvironmentOptions = {}
): Promise<RoleEnvironment> {
  const environment = roleEnvironment(driverName, role, options);
  const root = resolve(options.homeDirectory ?? homedir());
  const policy = rolePolicy(driverName, role, root);
  const baselineConfigPath =
    options.baselineConfigPath ?? policy.baselineConfigPath;
  const baseline = await readRoleBaseline([
    baselineConfigPath,
    environment.configPath,
  ]);
  const merged = mergeToml(
    mergeToml(baseline, options.roleOverlay ?? {}),
    enforcedOverlay(driverName, role, policy.sandboxMode)
  );
  if (isRecord(merged.overmind)) delete merged.overmind.causal_notebook;
  // Never inherit a previous Supervisor's grant or broader tool settings from disk.
  applyRoleMcpServers(merged, driverName, role, options.roleOverlay);
  if (driverName.trim().toLowerCase() === "codex")
    disableProviderRetries(merged);
  if (driverName.trim().toLowerCase() === "codex") {
    const disabled = await collectDisabledCodexSkills(
      root,
      environment.roleHome,
      role,
      options.cwd
    );
    mergeDisabledSkillConfig(
      merged,
      await readRoleBaseline([baselineConfigPath]),
      disabled
    );
  }
  await writeRoleConfig(environment.configPath, merged);
  const driver = driverName.trim().toLowerCase();
  if (role === "peer" && ["agy", "antigravity"].includes(driver)) {
    await writeAgyWebDenyHook(environment.roleHome);
    await writeAgyPeerAgent(environment.roleHome);
    // agy-acp hands these to every agy run. Headless agy cannot ask, so tools auto-approve;
    // the agent's tool list and the hook are the limits.
    return {
      ...environment,
      env: {
        ...environment.env,
        AGY_EXTRA_ARGS: `--agent ${AGY_PEER_AGENT} --dangerously-skip-permissions`,
      },
    };
  }
  if (driver !== "opencode") return environment;
  const overlay = await openCodeOverlay(
    role,
    join(root, ".config", "opencode")
  );
  return {
    ...environment,
    env: {
      ...environment.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay),
    },
  };
}

const OPENCODE_WEB_TOOLS = ["websearch", "codesearch", "webfetch"];

/** OpenCode permissions for the role; a denied tool is removed from the agent's toolset. */
async function openCodeOverlay(role: DriverRole, configRoot: string) {
  const permission: Record<string, unknown> = { task: "deny" };
  if (role === "supervisor")
    Object.assign(permission, { edit: "deny", bash: "deny" });
  if (role === "peer")
    for (const tool of OPENCODE_WEB_TOOLS) permission[tool] = "deny";
  const denied = new SkillFilteringEngine().overlay(role).denied_skills;
  permission.skill = Object.fromEntries([
    ["*", "allow"],
    ...denied.map((name) => [name, "deny"]),
  ]);
  if (role === "lead") return { permission };
  const mcp: Record<string, { enabled: false }> = {};
  for (const name of await openCodeMcpServers(configRoot))
    if (!ROLE_MCP_SERVERS.has(name)) mcp[name] = { enabled: false };
  return { permission, mcp };
}

async function openCodeMcpServers(configRoot: string): Promise<string[]> {
  const names: string[] = [];
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    const text = await readFile(join(configRoot, file), "utf8").catch(
      (error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      }
    );
    if (!text) continue;
    // shortcut: only whole-line // comments are stripped; a config with others is skipped.
    try {
      const config = JSON.parse(text.replace(/^\s*\/\/.*$/gmu, "")) as {
        mcp?: object;
      };
      names.push(...Object.keys(config.mcp ?? {}));
    } catch {
      continue;
    }
  }
  return names;
}

const AGY_PEER_AGENT = "overmind-peer";
/** The Peer's whole toolset: no web search, no sub-agents; images come from generate_image. */
const AGY_PEER_TOOLS = [
  "view_file",
  "list_dir",
  "find_by_name",
  "grep_search",
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
  "manage_task",
  "generate_image",
];

/** A primary AGY agent limited to AGY_PEER_TOOLS, found in AGY's global config root. */
async function writeAgyPeerAgent(roleHome: string): Promise<void> {
  const directory = join(roleHome, ".gemini", "config", "agents");
  await mkdir(directory, { recursive: true });
  const frontmatter = [
    "---",
    `name: ${AGY_PEER_AGENT}`,
    "description: Overmind Peer that implements one bounded task.",
    "mainAgent: true",
    "subagent: false",
    "tools:",
    ...AGY_PEER_TOOLS.map((tool) => `  - ${tool}`),
    "---",
  ];
  await writeFile(
    join(directory, `${AGY_PEER_AGENT}.md`),
    `${frontmatter.join("\n")}\n\n${promptForRole("peer")}\n`
  );
}

const AGY_WEB_DENY_HOOK = "overmind-peer-no-web";
const AGY_WEB_DENY_FILE = "overmind-deny-web.json";
const AGY_PEER_DENIED_TOOLS =
  "search_web|read_url_content|define_subagent|manage_subagents";

/**
 * AGY has no setting that removes its web tools, so a PreToolUse hook denies them. The
 * role home is AGY's home, which makes `<home>/.gemini/config` its global config root.
 */
async function writeAgyWebDenyHook(roleHome: string): Promise<void> {
  const directory = join(roleHome, ".gemini", "config");
  const hooksPath = join(directory, "hooks.json");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, AGY_WEB_DENY_FILE),
    JSON.stringify({
      decision: "deny",
      reason:
        "Overmind Peer: web search and new sub-agent definitions are disabled.",
    })
  );
  const existing = await readFile(hooksPath, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return "{}";
    throw error;
  });
  const hooks = JSON.parse(existing) as Record<string, unknown>;
  // Hooks run with the hooks.json directory as cwd, via cmd /c on Windows and sh -c elsewhere.
  const print = process.platform === "win32" ? "type" : "cat";
  hooks[AGY_WEB_DENY_HOOK] = {
    PreToolUse: [
      {
        // invoke_subagent stays: the built-in image-generator runs through it.
        matcher: AGY_PEER_DENIED_TOOLS,
        hooks: [
          {
            type: "command",
            command: `${print} ${AGY_WEB_DENY_FILE}`,
            timeout: 10,
          },
        ],
      },
    ],
  };
  await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
}

export function roleModelCatalogOptions(
  role: DriverRole
): Readonly<Record<string, unknown>> {
  assertRole(role);
  return Object.freeze({
    multi_agent_version: "disabled",
    agents: Object.freeze({ enabled: false }),
    features: Object.freeze({ multi_agent: false }),
  });
}

export function roleSandboxMode(role: DriverRole): RolePolicy["sandboxMode"] {
  assertRole(role);
  return sandboxModeForRole(role);
}
