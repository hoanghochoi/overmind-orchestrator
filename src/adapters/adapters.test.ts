import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexCliAdapter } from "./codex.js";
import { parse } from "smol-toml";
import { DriverRegistry } from "./registry.js";

describe("Overmind driver adapters", () => {
  test("registers supported drivers and falls back for unknown drivers", () => {
    expect(DriverRegistry.getAdapter(" CODEX ").driverName).toBe("codex");
    expect(DriverRegistry.getAdapter("custom-driver").driverName).toBe("generic");
    expect(new CodexCliAdapter().getModelCatalogOptions("lead")).toEqual({
      multi_agent_version: "disabled",
      agents: { enabled: false },
      features: { multi_agent: false },
    });
  });

  test("bootstraps an isolated Codex role home and merges enforced TOML guardrails", async () => {
    const root = await mkdtemp(join(tmpdir(), "overmind-role-"));
    try {
      const baseline = join(root, ".codex", "config.toml");
      await mkdir(join(root, ".codex"), { recursive: true });
      await writeFile(
        baseline,
        [
          'model = "baseline-model"',
          'sandbox_mode = "danger-full-access"',
          "[agents]",
          "enabled = true",
          "[features]",
          "multi_agent_v2 = true",
          "[custom]",
          'keep = "yes"',
          "[mcp_servers.codegraph]",
          'command = "codegraph"',
          "[mcp_servers.cloudflare]",
          'url = "https://example.invalid/mcp"',
          "",
        ].join("\n"),
        "utf8",
      );
      const env = await new CodexCliAdapter().buildSpawnEnv("supervisor", {
        homeDirectory: root,
      });
      const roleHome = join(root, ".codex", "roles", "supervisor");
      const config = parse(await readFile(join(roleHome, "config.toml"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(env).toMatchObject({
        CODEX_HOME: roleHome,
        OVERMIND_ROLE: "supervisor",
        OVERMIND_AGENTS_ENABLED: "true",
        OVERMIND_SANDBOX_MODE: "read-only",
      });
      expect(config).toMatchObject({
        model: "baseline-model",
        sandbox_mode: "read-only",
        agents: { enabled: false },
        features: { multi_agent_v2: false },
        memory: { causal_notebook: true },
        overmind: { multi_agent_version: "paseo" },
        custom: { keep: "yes" },
      });
      const peerEnv = await new CodexCliAdapter().buildSpawnEnv("peer", { homeDirectory: root });
      expect(peerEnv).toMatchObject({
        OVERMIND_SANDBOX_MODE: "workspace-write",
        OVERMIND_WEBSEARCH_ENABLED: "false",
      });
      // Owner MCP servers act outside the sandbox: Supervisor and Peer keep only the allowlist.
      expect(Object.keys(config.mcp_servers as object)).toEqual(["codegraph"]);
      await new CodexCliAdapter().buildSpawnEnv("lead", { homeDirectory: root });
      const leadConfig = parse(
        await readFile(join(root, ".codex", "roles", "lead", "config.toml"), "utf8"),
      ) as { mcp_servers: object };
      expect(Object.keys(leadConfig.mcp_servers)).toEqual(["codegraph", "cloudflare"]);
      const peerConfig = parse(
        await readFile(join(root, ".codex", "roles", "peer", "config.toml"), "utf8"),
      ) as Record<string, unknown>;
      expect(peerConfig).toMatchObject({
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: { network_access: true },
        web_search: "disabled",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preapproves only the current Supervisor wake and discards inherited grants", async () => {
    const root = await mkdtemp(join(tmpdir(), "overmind-wake-role-"));
    try {
      await mkdir(join(root, ".codex"), { recursive: true });
      await writeFile(
        join(root, ".codex", "config.toml"),
        [
          "[mcp_servers.overmind_wake]",
          'url = "https://stale.invalid/mcp"',
          'disabled_tools = ["create_supervisor_wake"]',
          "[mcp_servers.overmind_wake.tools.create_agent]",
          'approval_mode = "approve"',
        ].join("\n"),
      );
      const wake = {
        url: "http://127.0.0.1:12345/wake/current-grant",
        http_headers: { Authorization: "Bearer current-token" },
        enabled_tools: ["create_supervisor_wake"],
        default_tools_approval_mode: "prompt",
        tools: { create_supervisor_wake: { approval_mode: "approve" } },
      };
      const adapter = new CodexCliAdapter();
      const env = await adapter.buildSpawnEnv("supervisor", {
        homeDirectory: root,
        roleOverlay: { mcp_servers: { overmind_wake: wake } },
      });
      const read = async (home: string) => parse(await readFile(join(home, "config.toml"), "utf8"));
      expect((await read(env.CODEX_HOME!)).mcp_servers).toEqual({ overmind_wake: wake });
      expect((await read(env.CODEX_HOME!)).sandbox_mode).toBe("read-only");
      await adapter.buildSpawnEnv("supervisor", { homeDirectory: root });
      expect((await read(env.CODEX_HOME!)).mcp_servers).toEqual({});
      const peer = await adapter.buildSpawnEnv("peer", {
        homeDirectory: root,
        roleOverlay: { mcp_servers: { overmind_wake: wake } },
      });
      expect((await read(peer.CODEX_HOME!)).mcp_servers).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses a distinct physical home and provider key for every built-in adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "overmind-drivers-"));
    try {
      const expected = new Map([
        ["codex", "CODEX_HOME"],
        ["claude", "CLAUDE_CONFIG_DIR"],
        ["opencode", "OVERMIND_ROLE_HOME"],
        ["pi", "PI_CODING_AGENT_DIR"],
        ["agy", "GEMINI_CLI_HOME"],
        ["generic", "OVERMIND_HOME"],
      ]);
      const homes = new Set<string>();
      for (const [driver, envKey] of expected) {
        const env = await DriverRegistry.getAdapter(driver).buildSpawnEnv("lead", {
          homeDirectory: root,
        });
        expect(env[envKey]).toBeTruthy();
        homes.add(env[envKey]!);
        expect(env.OVERMIND_ROLE).toBe("lead");
        expect(env["memory.causal_notebook"]).toBe("false");
        expect(env).not.toHaveProperty("MEMORY_CAUSAL_NOTEBOOK");
      }
      expect(homes).toHaveLength(expected.size);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the owner's OpenCode config and denies a Peer's web tools inline", async () => {
    const root = await mkdtemp(join(tmpdir(), "overmind-opencode-"));
    try {
      const configRoot = join(root, ".config", "opencode");
      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "opencode.jsonc"),
        '// owner config\n{"mcp": {"codegraph": {}, "9remote": {}}, "model": "hive/deepseek"}',
      );
      const adapter = DriverRegistry.getAdapter("opencode");
      const peer = await adapter.buildSpawnEnv("peer", { homeDirectory: root });
      expect(peer).not.toHaveProperty("OPENCODE_CONFIG_DIR");
      expect(JSON.parse(peer.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
        permission: {
          task: "deny",
          websearch: "deny",
          webfetch: "deny",
          skill: { "*": "allow", "paseo*": "deny" },
        },
        mcp: { "9remote": { enabled: false } },
      });
      const lead = JSON.parse(
        (await adapter.buildSpawnEnv("lead", { homeDirectory: root })).OPENCODE_CONFIG_CONTENT!,
      );
      expect(lead).not.toHaveProperty("mcp");
      expect(lead.permission).not.toHaveProperty("webfetch");
      const supervisor = JSON.parse(
        (await adapter.buildSpawnEnv("supervisor", { homeDirectory: root }))
          .OPENCODE_CONFIG_CONTENT!,
      );
      expect(supervisor.permission).toMatchObject({ edit: "deny", bash: "deny" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denies AGY web tools for the Peer through a role-home hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "overmind-agy-"));
    try {
      const adapter = DriverRegistry.getAdapter("agy");
      const peer = await adapter.buildSpawnEnv("peer", { homeDirectory: root });
      const config = join(peer.USERPROFILE!, ".gemini", "config");
      const hooks = JSON.parse(await readFile(join(config, "hooks.json"), "utf8"));
      const group = hooks["overmind-peer-no-web"].PreToolUse[0];
      expect(group.matcher).toBe("search_web|read_url_content|define_subagent|manage_subagents");
      expect(group.matcher).not.toContain("generate_image");
      expect(
        JSON.parse(await readFile(join(config, "overmind-deny-web.json"), "utf8")),
      ).toMatchObject({ decision: "deny" });
      // The Peer runs as a primary agent whose tool list leaves out web search and sub-agents.
      expect(peer.AGY_EXTRA_ARGS).toBe("--agent overmind-peer --dangerously-skip-permissions");
      const agent = await readFile(join(config, "agents", "overmind-peer.md"), "utf8");
      expect(agent).toMatch(/^---\nname: overmind-peer\n[\s\S]* {2}- generate_image\n---\n/u);
      expect(agent).not.toMatch(/ - (?:search_web|read_url_content|\w*subagents?)\n/u);
      const lead = await adapter.buildSpawnEnv("lead", { homeDirectory: root });
      expect(lead).not.toHaveProperty("AGY_EXTRA_ARGS");
      await expect(
        readFile(join(lead.USERPROFILE!, ".gemini", "config", "hooks.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves dedicated role configuration and disables discovered native orchestration skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "overmind-native-skills-"));
    try {
      const workspace = join(root, "project");
      const deniedSkill = join(workspace, ".agents", "skills", "room-management");
      await mkdir(deniedSkill, { recursive: true });
      await writeFile(
        join(deniedSkill, "SKILL.md"),
        "---\nname: room-management\n---\nmanage rooms\n",
      );
      const adapter = new CodexCliAdapter();
      const first = await adapter.buildSpawnEnv("peer", { homeDirectory: root, cwd: workspace });
      const configPath = join(first.CODEX_HOME!, "config.toml");
      await writeFile(
        configPath,
        `${await readFile(configPath, "utf8")}\n[custom]\nkeep = "role-local"\n`,
      );
      // An entry generated under an earlier, narrower allowlist.
      const allowedSkill = join(workspace, ".agents", "skills", "9router-image", "SKILL.md");
      await writeFile(
        configPath,
        `${await readFile(configPath, "utf8")}\n[[skills.config]]\npath = ${JSON.stringify(allowedSkill)}\nenabled = false\n`,
      );
      await adapter.buildSpawnEnv("peer", { homeDirectory: root, cwd: workspace });
      const config = parse(await readFile(configPath, "utf8"));
      expect(config).toMatchObject({
        custom: { keep: "role-local" },
        skills: {
          config: expect.arrayContaining([{ path: join(deniedSkill, "SKILL.md"), enabled: false }]),
        },
      });
      expect(JSON.stringify(config)).not.toContain("9router-image");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
