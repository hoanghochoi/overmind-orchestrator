import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderOverride } from "@getpaseo/protocol/provider-config";
import { overmindSettings, profileBinding } from "../shared/settings.js";
import { roleForProvider } from "../shared/providers.js";
import {
  enforcedProviderOptions,
  profileStatuses,
  publishProfiles,
  resolveDriver,
  seatProfiles,
} from "../server/providers.js";
import { checkJev, evaluateJev } from "../server/jev.js";
import { imageDataUri } from "../server/image.js";
import {
  DetectionMonitor,
  detectOutput,
  detectUnverifiedClaim,
  latestExchange,
  matchRules,
} from "../server/detection.js";
import { RepetitionTracker } from "../server/repetition.js";
import { SeatStore } from "../server/seat-store.js";
import { isOvermindAgent } from "../shared/membership.js";
import { createContribution } from "../server/index.js";
import { CausalNotebook } from "../server/modules/causal_notebook.js";
import { DriverRegistry } from "../server/adapters/index.js";
import { DetectionLog } from "../server/detection-log.js";
import { encodeTexts } from "../server/embedding.js";

vi.mock("../server/embedding.js", () => ({
  configureEmbeddingRuntime: vi.fn(),
  encodeTexts: vi.fn(async () => [
    [1, 0],
    [1, 0],
  ]),
  prepareBuiltinEmbedding: vi.fn(async () => undefined),
  builtinEmbeddingStatus: () => ({ status: "ready", progress: 100, error: null }),
  checkEmbedding: vi.fn(),
  listEmbeddingModels: vi.fn(),
  disposeEmbedding: vi.fn(),
}));

function profileApi(providers: Record<string, unknown> = {}) {
  let config = { providers };
  const patch = vi.fn(
    async (input: { providers?: Record<string, object>; removeProviders?: string[] }) => {
      const next: Record<string, unknown> = { ...config.providers };
      for (const id of input.removeProviders ?? []) delete next[id];
      // Paseo merges a provider patch: keys it omits keep their old value.
      for (const [id, entry] of Object.entries(input.providers ?? {}))
        next[id] = { ...(next[id] as object), ...entry };
      config = { providers: next };
      return { config };
    },
  );
  const api = {
    config: { get: async () => ({ config }), patch },
    providers: {
      listModels: async () => ({
        models: [
          { id: "chosen", label: "Chosen", thinkingOptions: [{ id: "high", label: "High" }] },
        ],
      }),
    },
  } as unknown as PaseoApi;
  return { api, patch, getConfig: () => config };
}

async function listening(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).status === 403;
  } catch {
    return false;
  }
}

describe("Overmind control backend", () => {
  test("reads a host image an agent linked, and nothing that is not an image", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "overmind-image-"));
    try {
      const png = path.join(root, "concept.png");
      await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const expected = "data:image/png;base64,iVBORw==";
      expect(await imageDataUri(png)).toBe(expected);
      expect(await imageDataUri(pathToFileURL(png).href)).toBe(expected);
      await writeFile(path.join(root, "secret.txt"), "token");
      await expect(imageDataUri(path.join(root, "secret.txt"))).rejects.toThrow("png, jpg");
      await expect(imageDataUri("concept.png")).rejects.toThrow("tuyệt đối");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes owned native profiles and verifies the model and thinking", async () => {
    const values = overmindSettings.schema.parse({
      supervisor: { provider: "codex", model: "chosen", thinkingOptionId: "high" },
    });
    const fixture = profileApi();
    const result = await publishProfiles(fixture.api, values);
    expect(result[0].status).toBe("ready");
    expect(fixture.patch).toHaveBeenCalledOnce();
    expect(fixture.getConfig().providers["overmind-supervisor"]).toMatchObject({
      extends: "codex",
      label: "Overmind Supervisor",
      env: { OVERMIND_ROLE: "supervisor", OVERMIND_PROFILE_OWNER: "paseo-plugin-overmind" },
      models: [{ id: "chosen", thinkingOptions: [{ id: "high", isDefault: true }] }],
    });
    expect((await profileStatuses(fixture.api, values))[0].status).toBe("ready");
  });

  test("profiles keep the Supervisor read-only and Claude seats without native sub-agents", async () => {
    const values = overmindSettings.schema.parse({
      supervisor: { provider: "codex", model: "chosen", thinkingOptionId: "high" },
      lead: { provider: "claude", model: "chosen", thinkingOptionId: "high" },
    });
    const fixture = profileApi();
    await publishProfiles(fixture.api, values);
    const { providers } = fixture.getConfig() as {
      providers: Record<string, { options?: object; disallowedTools?: string[] }>;
    };
    // Profile options outrank the permission mode Settings picks for the seat.
    expect(providers["overmind-supervisor"]!.options).toEqual({ sandbox_mode: "read-only" });
    expect(providers["overmind-lead"]!.disallowedTools).toEqual(["Task", "Agent"]);
    // Republishing the enforced profile is not mistaken for a leftover override.
    expect((await publishProfiles(fixture.api, values)).map((entry) => entry.status)).toEqual([
      "ready",
      "ready",
      "unconfigured",
    ]);
    // A profile published before enforcement is reported as needing registration.
    const stale = profileApi({
      "overmind-supervisor": { ...providers["overmind-supervisor"], options: undefined },
    });
    expect((await profileStatuses(stale.api, values))[0].status).toBe("missing");
    expect(enforcedProviderOptions("supervisor", "claude", {})).toEqual({
      disallowedTools: ["Task", "Agent", "Edit", "Write", "NotebookEdit", "Bash"],
    });
    expect(enforcedProviderOptions("peer", "codex", { web_search: "disabled" })).toEqual({
      web_search: "disabled",
    });
  });

  test("switching a role to another provider drops the old provider overrides", async () => {
    const claudeLead = overmindSettings.schema.parse({
      lead: { provider: "claude", model: "chosen", thinkingOptionId: "high" },
    });
    const fixture = profileApi();
    await publishProfiles(fixture.api, claudeLead);
    const codexLead = overmindSettings.schema.parse({
      lead: { provider: "codex", model: "chosen", thinkingOptionId: "high" },
    });
    expect((await publishProfiles(fixture.api, codexLead))[1]).toMatchObject({ status: "ready" });
    expect(fixture.patch).toHaveBeenCalledWith({ removeProviders: ["overmind-lead"] });
    const lead = fixture.getConfig().providers["overmind-lead"] as ProviderOverride;
    expect(lead).toMatchObject({ extends: "codex", env: { OVERMIND_SOURCE_PROVIDER: "codex" } });
    expect(lead.disallowedTools).toBeUndefined();
  });

  test("disables the profiles of removed Peer kinds", async () => {
    const values = overmindSettings.schema.parse({
      peer: { provider: "codex", model: "chosen" },
      peerKinds: [{ id: "scout", purpose: "Scout", provider: "opencode", model: "chosen" }],
    });
    expect(values).not.toHaveProperty("peerKinds");
    const fixture = profileApi({
      "overmind-peer-old": {
        extends: "codex",
        env: { OVERMIND_PROFILE_OWNER: "paseo-plugin-overmind" },
      },
    });
    const result = await publishProfiles(fixture.api, values);
    expect(result.map((entry) => entry.id)).toEqual([
      "overmind-supervisor",
      "overmind-lead",
      "overmind-peer",
    ]);
    expect(fixture.getConfig().providers["overmind-peer-old"]).toMatchObject({ enabled: false });
    // A live seat created from an old kind profile is still a Peer.
    expect(roleForProvider("overmind-peer-old")).toBe("peer");
    expect(profileBinding(values, "overmind-peer-old")).toBeNull();
    expect((await seatProfiles(fixture.api, values)).map((entry) => entry.provider)).toEqual([
      "overmind-peer",
    ]);
  });

  test("an agy-acp ACP provider backs a Peer but no other role", async () => {
    const values = overmindSettings.schema.parse({
      lead: { provider: "agy-acp", model: "chosen" },
      peer: { provider: "agy-acp", model: "chosen" },
    });
    const fixture = profileApi({
      "agy-acp": {
        extends: "acp",
        label: "Antigravity ACP",
        command: ["C:\\tools\\agy-acp\\target\\release\\agy-acp.exe"],
      },
    });
    const result = await publishProfiles(fixture.api, values);
    expect(result[1]).toMatchObject({ status: "error", error: "agy-acp chỉ dùng được cho Peer." });
    expect(result[2]).toMatchObject({ id: "overmind-peer", status: "ready" });
    expect(fixture.getConfig().providers["overmind-peer"]).toMatchObject({
      extends: "acp",
      command: ["C:\\tools\\agy-acp\\target\\release\\agy-acp.exe"],
    });
    expect(await resolveDriver(fixture.api, "overmind-peer")).toBe("agy");
    expect(await resolveDriver(fixture.api, "codex")).toBe("codex");
  });

  test("preserves foreign profiles and rejects plugin inheritance before writing config", async () => {
    const foreign = profileApi({ "overmind-supervisor": { label: "My provider" } });
    const values = overmindSettings.schema.parse({
      supervisor: { provider: "codex", model: "chosen" },
      lead: { provider: "antigravity", model: "chosen" },
    });
    const result = await publishProfiles(foreign.api, values);
    expect(result[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("không ghi đè"),
    });
    expect(result[1]).toMatchObject({
      status: "error",
      error: expect.stringContaining("provider plugin"),
    });
    expect(foreign.patch).not.toHaveBeenCalled();
  });

  test("only accepts explicit Overmind markers or profile IDs", () => {
    expect(isOvermindAgent({}, "overmind-supervisor")).toBe(true);
    expect(isOvermindAgent({}, "codex")).toBe(false);
    expect(isOvermindAgent({ "overmind.enabled": "false" }, "overmind-peer")).toBe(false);
  });

  test("uses custom regexes and real semantic encoder results after regex fallback", async () => {
    const values = overmindSettings.schema.parse({
      detection: {
        includeDefaults: false,
        extraPatterns: ["needs human"],
        references: ["blocked"],
        threshold: 0.9,
      },
    });
    expect(await detectOutput(values, "This needs human review")).toMatchObject({
      tier: "hybrid",
      patterns: ["custom-1"],
      matched: "This needs human review",
      confirmed: true,
    });
    expect(await detectOutput(values, "Unresolved blocker")).toMatchObject({
      tier: "semantic",
      score: 1,
    });
    expect(await detectOutput(values, "")).toBeNull();
    expect(() => overmindSettings.schema.parse({ detection: { extraPatterns: ["("] } })).toThrow();
  });

  test("takes the latest user exchange and never appends alerts for ordinary agents", async () => {
    expect(
      latestExchange([
        { type: "user_message", text: "old" },
        { type: "assistant_message", text: "old answer" },
        { type: "user_message", text: "latest" },
        { type: "assistant_message", text: "but blocked" },
      ]),
    ).toEqual({ objective: "latest", output: "but blocked", verified: false });
    const append = vi.fn();
    const refetch = vi.fn();
    const api = {
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: { labels: {} } }),
          timeline: { append, refetch },
        }),
      },
    } as unknown as PaseoApi;
    const monitor = new DetectionMonitor();
    const agent: PluginHookAgent = {
      id: "ordinary",
      provider: "codex",
      cwd: ".",
      workspaceId: null,
      parentAgentId: null,
      title: null,
    };
    await monitor.onTurnEnded(
      agent,
      "turn",
      { kind: "completed" },
      api,
      overmindSettings.schema.parse({}),
    );
    expect(refetch).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    monitor.dispose();
  });

  test("ignores a bare 'but', logs rejected candidates and skips the Supervisor", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "overmind-detections-"));
    const log = new DetectionLog(path.join(directory, "detections.jsonl"));
    const values = overmindSettings.schema.parse({});
    try {
      expect(matchRules(values, "It works, but the docs are thin.")).toBeNull();
      expect(matchRules(values, "Tôi vẫn lỗi ở bước migrate.")).toMatchObject({
        patterns: ["vi-repeated-failure"],
        antiPatterns: ["repeated-local-patch"],
      });
      const append = vi.fn();
      const refetch = vi.fn(async () => ({
        entries: [
          { item: { type: "user_message", text: "check" } },
          { item: { type: "assistant_message", text: "I'm blocked until the review lands." } },
        ],
      }));
      const api = {
        agents: {
          ref: () => ({
            refresh: async () => ({ agent: { labels: {} } }),
            timeline: { refetch, append },
          }),
        },
      } as unknown as PaseoApi;
      const peer: PluginHookAgent = {
        id: "peer",
        provider: "overmind-peer",
        cwd: ".",
        workspaceId: "ws",
        parentAgentId: "lead",
        title: "Peer",
      };
      const monitor = new DetectionMonitor({ log });
      // The semantic check finds no resemblance to a reference problem.
      vi.mocked(encodeTexts).mockResolvedValueOnce([
        [1, 0],
        [0, 1],
      ]);
      await monitor.onTurnEnded(peer, "t1", { kind: "completed" }, api, values);
      expect(append).not.toHaveBeenCalled();
      const [entry] = await log.read();
      expect(entry).toMatchObject({
        agentId: "peer",
        patterns: ["blocked"],
        semanticScore: 0,
        confirmed: false,
      });
      expect(entry!.matched).toContain("I'm blocked");
      expect(DetectionLog.summarize(await log.read())).toEqual([
        { rule: "blocked", hits: 1, confirmed: 0 },
      ]);

      await monitor.onTurnEnded(
        { ...peer, id: "sup", provider: "overmind-supervisor", parentAgentId: null },
        "t2",
        { kind: "completed" },
        api,
        values,
      );
      expect(refetch).toHaveBeenCalledOnce();
      monitor.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("flags a completion claim from a turn that ran no check", () => {
    const values = overmindSettings.schema.parse({});
    const exchange = (items: unknown[]) =>
      latestExchange([{ type: "user_message", text: "fix login" }, ...items] as never);
    const claim = { type: "assistant_message", text: "The login bug is fixed now." };
    expect(detectUnverifiedClaim(values, exchange([claim]))).toMatchObject({
      tier: "structural",
      antiPatterns: ["weak-verification"],
      matched: "The login bug is fixed now.",
    });
    const check = { type: "tool_call", name: "shell", detail: { command: "npx vitest run" } };
    expect(detectUnverifiedClaim(values, exchange([check, claim]))).toBeNull();
    expect(
      detectUnverifiedClaim(values, exchange([{ type: "assistant_message", text: "Looking." }])),
    ).toBeNull();
  });

  test("a third stalled turn tells the Lead to change direction and the Supervisor to watch", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "overmind-repeat-"));
    const seats = new SeatStore(path.join(directory, "seats.json"));
    const repetition = new RepetitionTracker(seats);
    const sent: { to: string; text: string }[] = [];
    const agents: Record<string, { provider: string; labels: Record<string, string> }> = {
      peer: { provider: "overmind-peer", labels: { "paseo.parent-agent-id": "lead" } },
      lead: { provider: "overmind-lead", labels: { "paseo.parent-agent-id": "sup" } },
      sup: { provider: "overmind-supervisor", labels: {} },
    };
    const api = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({
            agent: { id, title: id, status: "idle", archivedAt: null, ...agents[id] },
          }),
          send: async (text: string) => {
            sent.push({ to: id, text });
          },
          timeline: {
            append: vi.fn(),
            refetch: async () => ({
              entries: [
                { item: { type: "user_message", text: "make the migration pass" } },
                { item: { type: "assistant_message", text: "Still failing on the same index." } },
              ],
            }),
          },
        }),
      },
    } as unknown as PaseoApi;
    const peer: PluginHookAgent = {
      id: "peer",
      provider: "overmind-peer",
      cwd: ".",
      workspaceId: "ws",
      parentAgentId: "lead",
      title: "Peer",
    };
    const monitor = new DetectionMonitor({ repetition });
    const values = overmindSettings.schema.parse({ detection: { mode: "regex" } });
    try {
      for (const turnId of ["t1", "t2"])
        await monitor.onTurnEnded(peer, turnId, { kind: "completed" }, api, values);
      expect(sent.some((entry) => entry.text.includes("OVERMIND REPETITION"))).toBe(false);
      await monitor.onTurnEnded(peer, "t3", { kind: "completed" }, api, values);
      const toLead = sent.find((entry) => entry.to === "lead" && entry.text.includes("ĐỔI HƯỚNG"));
      expect(toLead?.text).toContain("Repeated local patches");
      expect(toLead?.text).toContain("newApproach");
      expect(sent.some((entry) => entry.to === "sup" && entry.text.includes("THEO DÕI"))).toBe(
        true,
      );
      expect((await seats.get("peer"))["overmind.repeat.escalated"]).toBe("repeated-local-patch");
      // The open escalation is not repeated on the next stalled turn.
      sent.length = 0;
      await monitor.onTurnEnded(peer, "t4", { kind: "completed" }, api, values);
      expect(sent.some((entry) => entry.text.includes("OVERMIND REPETITION"))).toBe(false);
      monitor.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("progress resets the count and a new approach closes the escalation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "overmind-repeat-"));
    const seats = new SeatStore(path.join(directory, "seats.json"));
    const repetition = new RepetitionTracker(seats);
    const stalled = new Map([["loss-of-momentum", "I'm blocked"]]);
    try {
      await repetition.observe("lead", "t1", stalled);
      await repetition.observe("lead", "t2", stalled);
      await repetition.observe("lead", "t3", new Map());
      // A turn without the anti-pattern is progress: nothing is tracked any more.
      expect(await seats.get("lead")).toEqual({});
      for (const turnId of ["t4", "t5"]) await repetition.observe("lead", turnId, stalled);
      const [escalation] = await repetition.observe("lead", "t6", stalled);
      expect(escalation).toMatchObject({ antiPattern: "loss-of-momentum", count: 3 });
      expect(escalation!.evidence.map((entry) => entry.turnId)).toEqual(["t4", "t5", "t6"]);
      await repetition.redirect("lead");
      expect(await seats.get("lead")).toEqual({});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("tests Typesafe with synthetic content and reports the resolved model", async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models"))
        return Response.json({ models: [{ name: "jev-latest" }] });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        model: "jev-concrete",
        answers: {
          hazard: {
            type: "choice",
            choice: "review",
            confidence: 0.9,
            probabilities: { normal: 0.05, review: 0.9, insufficient: 0.05 },
          },
        },
      });
    }) as typeof fetch;
    const values = overmindSettings.schema.parse({ jev: { apiKey: "test-only" } });
    const result = await checkJev(values.jev, fetcher);
    expect(result).toMatchObject({ ok: true, model: "jev-concrete", models: ["jev-latest"] });
    expect(bodies[0]).toMatchObject({
      questions: { hazard: { type: "choice" } },
      state: { signals: ["synthetic connectivity test"] },
    });
    expect(
      await evaluateJev(
        { ...values.jev, minConfidence: 0.95 },
        { objective: "test", output: "test", signals: [] },
        fetcher,
      ),
    ).toMatchObject({ verdict: "uncertain" });
    expect(
      await evaluateJev(values.jev, { objective: "test", output: "test", signals: [] }, fetcher),
    ).toMatchObject({ verdict: "review" });
  });

  test("appends one alert per Overmind turn with JEV disabled by default", async () => {
    const append = vi.fn();
    const refetch = vi.fn(async () => ({
      entries: [
        { item: { type: "user_message", text: "finish task" } },
        { item: { type: "assistant_message", text: "I'm blocked on the schema migration." } },
      ],
    }));
    const api = {
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: { labels: {} } }),
          timeline: { refetch, append },
        }),
      },
    } as unknown as PaseoApi;
    const agent: PluginHookAgent = {
      id: "overmind",
      provider: "overmind-lead",
      cwd: ".",
      workspaceId: null,
      parentAgentId: null,
      title: "Lead",
    };
    const monitor = new DetectionMonitor();
    const values = overmindSettings.schema.parse({});
    await monitor.onTurnEnded(agent, "1", { kind: "completed" }, api, values);
    await monitor.onTurnEnded(agent, "1", { kind: "completed" }, api, values);
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "anomaly",
        data: expect.objectContaining({ agentId: "overmind", tier: "hybrid", jev: null }),
      }),
    );
    expect(monitor.status()).toMatchObject({ lastError: null, alerts: [{ agentId: "overmind" }] });
    monitor.dispose();
  });

  test("raises a Tier 1 alert from the live reasoning stream before the turn ends", async () => {
    const append = vi.fn();
    let emit: ((event: unknown) => void) | undefined;
    const api = {
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: { id: "peer", status: "idle", labels: {} } }),
          timeline: {
            append,
            subscribe: vi.fn((handler: (event: unknown) => void) => {
              emit = handler;
              return () => undefined;
            }),
          },
        }),
      },
    } as unknown as PaseoApi;
    const agent: PluginHookAgent = {
      id: "peer",
      provider: "overmind-peer",
      cwd: ".",
      workspaceId: "workspace",
      parentAgentId: null,
      title: "Peer",
    };
    const monitor = new DetectionMonitor();
    await monitor.onTurnStarted(agent, "turn-1", api, overmindSettings.schema.parse({}));
    emit?.({
      event: {
        type: "timeline",
        item: { type: "reasoning", text: "I am blocked by the missing schema." },
      },
    });
    await vi.waitUntil(() => monitor.status().alerts.length > 0);
    expect(monitor.status().alerts[0]).toMatchObject({
      agentId: "peer",
      tier: "hybrid",
      patterns: ["blocked"],
    });
    expect(append).toHaveBeenCalled();
    monitor.dispose();
  });

  test("holds a Supervisor alert while it is thinking and releases it without steering", async () => {
    const append = vi.fn();
    const send = vi.fn(async () => undefined);
    const sourceRef = {
      refresh: vi.fn(async () => ({
        agent: {
          id: "lead",
          provider: "overmind-lead",
          workspaceId: "workspace",
          labels: { "overmind.enabled": "true" },
          status: "idle",
        },
      })),
      timeline: {
        refetch: vi.fn(async () => ({
          entries: [
            { item: { type: "user_message", text: "finish task" } },
            { item: { type: "assistant_message", text: "I'm blocked on the schema migration." } },
          ],
        })),
        append,
        subscribe: vi.fn(() => () => undefined),
      },
    };
    let supervisorStatus = "running";
    const supervisorRef = {
      refresh: vi.fn(async () => ({
        agent: {
          id: "supervisor",
          provider: "overmind-supervisor",
          workspaceId: "workspace",
          labels: {},
          status: supervisorStatus,
          archivedAt: null,
        },
      })),
      timeline: {
        refetch: vi.fn(async () => ({ entries: [] })),
        append,
        subscribe: vi.fn(() => () => undefined),
      },
      send,
    };
    const api = {
      agents: {
        list: vi.fn(async () => ({
          entries: [
            {
              agent: {
                id: "supervisor",
                provider: "overmind-supervisor",
                workspaceId: "workspace",
                status: "running",
                archivedAt: null,
              },
            },
          ],
        })),
        ref: vi.fn((agent: string) => (agent === "lead" ? sourceRef : supervisorRef)),
      },
    } as unknown as PaseoApi;
    const source: PluginHookAgent = {
      id: "lead",
      provider: "overmind-lead",
      cwd: ".",
      workspaceId: "workspace",
      parentAgentId: "supervisor",
      title: "Lead",
    };
    const supervisor: PluginHookAgent = {
      id: "supervisor",
      provider: "overmind-supervisor",
      cwd: ".",
      workspaceId: "workspace",
      parentAgentId: null,
      title: "Supervisor",
    };
    const monitor = new DetectionMonitor();
    const values = overmindSettings.schema.parse({});

    await monitor.onTurnEnded(source, "lead-turn", { kind: "completed" }, api, values);
    expect(send).not.toHaveBeenCalled();
    expect(monitor.status().alerts[0]).toMatchObject({
      supervisorDelivery: { status: "queued", agentId: "supervisor" },
      supervisorNotified: false,
    });

    await monitor.onTurnStarted(supervisor, "supervisor-turn", api, values);
    supervisorStatus = "idle";
    await monitor.onTurnEnded(supervisor, "supervisor-turn", { kind: "completed" }, api, values);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.stringContaining("[OVERMIND ANOMALY]"), {
      sourceAgentId: "lead",
    });
    expect(send.mock.calls[0]?.[1]).not.toHaveProperty("activeTurnBehavior");
    expect(monitor.status().alerts[0]).toMatchObject({
      supervisorDelivery: { status: "sent", agentId: "supervisor" },
      supervisorNotified: true,
    });
    monitor.dispose();
  });

  test("surfaces failed credentials without echoing the key", async () => {
    const values = overmindSettings.schema.parse({ jev: { apiKey: "secret-test-only" } });
    const result = await checkJev(
      values.jev,
      (async () => new Response("Unauthorized", { status: 401 })) as typeof fetch,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 401");
    expect(result.message).not.toContain(values.jev.apiKey);
  });

  test("gives seats the plugin's checked tools and requires a ticket for Leads", async () => {
    const values = overmindSettings.schema.parse({
      supervisor: {
        provider: "codex",
        model: "chosen",
        thinkingOptionId: "xhigh",
        modeId: "full-access",
      },
      lead: { provider: "codex", model: "chosen" },
    });
    const before = vi.fn(() => () => undefined);
    const server = {
      registerSettings: () => ({
        read: async () => ({ status: "ready", values, revision: "1" }),
        subscribe: () => () => undefined,
      }),
      before,
      on: vi.fn(() => () => undefined),
      handle: vi.fn(),
    } as unknown as PluginServerContext;
    const env = vi
      .spyOn(DriverRegistry.getAdapter("codex"), "buildSpawnEnv")
      .mockResolvedValue({ CODEX_HOME: "role-home" });
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "overmind-state-"));
    const cleanup = createContribution({ stateDirectory })(server);
    try {
      const fixture = profileApi();
      const context = { paseo: fixture.api, signal: new AbortController().signal };
      const create = before.mock.calls.find(([name]) => name === "agent.create")?.[1];
      const request = await create(
        { request: { config: { provider: "overmind-supervisor", cwd: "." } } },
        context,
      );
      expect(request.config).toMatchObject({
        model: "chosen",
        thinkingOptionId: "xhigh",
        modeId: "full-access",
        featureValues: { overmindRole: "supervisor", overmindDriver: "codex" },
        mcpServers: {
          overmind: { type: "http", url: expect.stringMatching(/\/overmind\/[0-9a-f-]+$/) },
          overmind_notebook: { type: "http", url: expect.stringMatching(/\/notebook\//) },
        },
        toolPolicy: {
          preapproved: expect.arrayContaining([
            { kind: "mcp", server: "overmind", tool: "create_agent" },
            { kind: "mcp", server: "overmind", tool: "create_supervisor_wake" },
            { kind: "mcp", server: "overmind", tool: "overmind_task_review" },
            { kind: "mcp", server: "overmind_notebook", tool: "causal_notebook_write" },
          ]),
        },
      });
      // Every preapproved server ships in the same request, as the daemon requires.
      for (const grant of request.config.toolPolicy.preapproved)
        expect(request.config.mcpServers).toHaveProperty(grant.server);
      expect(request.config.toolPolicy.preapproved.map((grant) => grant.tool)).not.toContain(
        "contract_lock",
      );
      expect(request.env.OVERMIND_CAPABILITY_ID).toEqual(expect.any(String));

      const open = before.mock.calls.find(([name]) => name === "agent.session_open")?.[1];
      const launch = await open(
        {
          request: {
            agentId: "supervisor",
            provider: "overmind-supervisor",
            cwd: ".",
            env: request.env,
            reason: "create",
          },
        },
        context,
      );
      expect(launch.env).toMatchObject({
        CODEX_HOME: "role-home",
        OVERMIND_NATIVE_SUBAGENTS_ENABLED: "false",
      });

      await expect(
        create({ request: { config: { provider: "overmind-lead", cwd: "." } } }, context),
      ).rejects.toThrow("OVERMIND_ROLE_DENIED");
    } finally {
      await cleanup();
      env.mockRestore();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("a reloaded plugin listens on the persisted endpoint before a live seat's next turn", async () => {
    const values = overmindSettings.schema.parse({
      supervisor: { provider: "codex", model: "chosen" },
    });
    const contribution = () => {
      const before = vi.fn(() => () => undefined);
      const on = vi.fn(() => () => undefined);
      const server = {
        registerSettings: () => ({
          read: async () => ({ status: "ready", values, revision: "1" }),
          subscribe: () => () => undefined,
        }),
        before,
        on,
        handle: vi.fn(),
      } as unknown as PluginServerContext;
      return { server, before, on };
    };
    const env = vi
      .spyOn(DriverRegistry.getAdapter("codex"), "buildSpawnEnv")
      .mockResolvedValue({ CODEX_HOME: "role-home" });
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "overmind-state-"));
    const context = { paseo: profileApi().api, signal: new AbortController().signal };
    try {
      const first = contribution();
      const cleanupFirst = createContribution({ stateDirectory })(first.server);
      const create = first.before.mock.calls.find(([name]) => name === "agent.create")![1];
      const request = await create(
        { request: { config: { provider: "overmind-supervisor", cwd: "." } } },
        context,
      );
      const url = request.config.mcpServers.overmind.url as string;
      expect((await fetch(url)).status).toBe(403);
      await cleanupFirst();
      await expect(fetch(url)).rejects.toThrow();

      const second = contribution();
      const cleanupSecond = createContribution({ stateDirectory })(second.server);
      try {
        const started = second.on.mock.calls.find(([name]) => name === "agent.turn_started")![1];
        const agent: PluginHookAgent = {
          id: "supervisor",
          provider: "overmind-supervisor",
          cwd: ".",
          workspaceId: "ws-1",
          parentAgentId: null,
          title: "Supervisor",
        };
        started({ agent, turnId: "t1" }, context);
        await vi.waitUntil(() => listening(url));
      } finally {
        await cleanupSecond();
      }
    } finally {
      env.mockRestore();
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("reads the owner notebook and writes seat state at turn boundaries", async () => {
    const values = overmindSettings.schema.parse({});
    const on = vi.fn(() => () => undefined);
    const handle = vi.fn();
    const server = {
      registerSettings: () => ({
        read: async () => ({ status: "ready", values, revision: "1" }),
        subscribe: () => () => undefined,
      }),
      before: vi.fn(() => () => undefined),
      on,
      handle,
    } as unknown as PluginServerContext;
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "overmind-state-"));
    const cleanup = createContribution({ stateDirectory })(server);
    const directory = await mkdtemp(path.join(tmpdir(), "overmind-notebook-owner-"));
    try {
      await new CausalNotebook(directory, stateDirectory).write(
        { provider: "overmind-supervisor", agentId: "supervisor" },
        {
          workspace_id: "ws-1",
          session_id: "session-1",
          observation: "Repeated waiting",
          evidence: [{ kind: "quote", content: "Wait again" }],
          suspected_mechanism: "Quota exhaustion",
          impact: "Progress blocked",
          recommendation: "Verify provider availability",
          protocol_candidate: false,
        },
      );
      const paseo = {
        workspaces: { ref: () => ({ refresh: async () => ({ projectRootPath: directory }) }) },
        projects: {
          list: async () => ({
            projects: [{ projectDisplayName: "Repo", projectRootPath: directory }],
          }),
        },
        agents: {
          ref: () => ({
            refresh: async () => null,
            timeline: {
              refetch: async () => ({ entries: [] }),
              append: vi.fn(),
              subscribe: vi.fn(() => () => undefined),
            },
          }),
        },
      } as unknown as PaseoApi;
      const readHistory = handle.mock.calls.find(
        ([contract]) => contract.name === "project.history",
      )![1];
      expect(await readHistory({}, { paseo })).toMatchObject({
        errors: [],
        projects: [
          {
            name: "Repo",
            tasks: [],
            notebook: [
              {
                workspaceId: "ws-1",
                observation: "Repeated waiting",
                suspectedMechanism: "Quota exhaustion",
                evidenceCount: 1,
                protocolCandidate: false,
              },
            ],
          },
        ],
      });

      // Archiving a Lead keeps its task, with the plugin's seat labels, in the project.
      const archivedLead = {
        id: "old-lead",
        provider: "overmind-lead",
        model: "m",
        title: "Old Lead",
        status: "closed",
        workspaceId: "ws-1",
        lastUserMessageAt: null,
        archivedAt: "2026-10-29T00:00:00.000Z",
        labels: { "paseo.parent-agent-id": "sup" },
      };
      const archive = on.mock.calls.find(([event]) => event === "agent.archived")![1];
      const archiveHost = {
        ...paseo,
        agents: { ref: () => ({ refresh: async () => ({ agent: archivedLead }) }) },
      } as unknown as PaseoApi;
      await archive(
        { agent: { ...archivedLead, cwd: ".", parentAgentId: "sup" } },
        { paseo: archiveHost },
      );
      const [project] = (await readHistory({}, { paseo })).projects;
      expect(project.tasks).toMatchObject([
        {
          agentId: "old-lead",
          title: "Old Lead",
          archivedAt: "2026-10-29T00:00:00.000Z",
          labels: { "paseo.parent-agent-id": "sup" },
        },
      ]);

      const agent: PluginHookAgent = {
        id: "lead",
        provider: "overmind-lead",
        cwd: ".",
        workspaceId: "ws-1",
        parentAgentId: null,
        title: "Lead",
      };
      const started = on.mock.calls.find(([event]) => event === "agent.turn_started")![1];
      const ended = on.mock.calls.find(([event]) => event === "agent.turn_ended")![1];
      const readSeats = handle.mock.calls.find(([contract]) => contract.name === "seat.labels")![1];
      const seat = async () => (await readSeats({ agentIds: ["lead"] }, { paseo })).seats.lead;
      started({ agent, turnId: "t1" }, { paseo });
      await vi.waitUntil(async () => (await seat())?.["overmind.status"] === "THINKING");
      expect(await seat()).toEqual({
        "overmind.status": "THINKING",
        "overmind.task.status": "IN_PROGRESS",
        "overmind.turn.id": "t1",
        "overmind.turn.outcome": "running",
      });
      await ended({ agent, turnId: "t1", outcome: { kind: "completed" } }, { paseo });
      expect(await seat()).toEqual({
        "overmind.status": "IDLE",
        "overmind.task.status": "READY_FOR_REVIEW",
        "overmind.turn.id": "t1",
        "overmind.turn.outcome": "completed",
        "overmind.mailbox_count": "0",
      });
      started({ agent, turnId: "t2" }, { paseo });
      await ended(
        {
          agent,
          turnId: "t2",
          outcome: { kind: "failed", error: { message: "Validation failed" } },
        },
        { paseo },
      );
      expect(await seat()).toMatchObject({
        "overmind.turn.id": "t2",
        "overmind.turn.outcome": "failed",
        "overmind.task.status": "IN_PROGRESS",
      });

      // A turn that ends while the plugin is reloading leaves the seat THINKING.
      started({ agent, turnId: "t3" }, { paseo });
      await vi.waitUntil(async () => (await seat())?.["overmind.turn.id"] === "t3");
      const handleAfterReload = vi.fn();
      const reloaded = createContribution({ stateDirectory })({
        ...server,
        handle: handleAfterReload,
      } as PluginServerContext);
      const idleLead = {
        id: "lead",
        provider: "overmind-lead",
        status: "idle",
        activeTurn: null,
        archivedAt: null,
        cwd: ".",
        workspaceId: "ws-1",
        title: "Lead",
        labels: {},
      };
      const host = {
        agents: {
          list: async () => ({ entries: [{ agent: idleLead }] }),
          ref: () => ({
            refresh: async () => ({ agent: idleLead }),
            timeline: {
              refetch: async () => ({
                entries: [{ turnId: "t3", item: { type: "assistant_message", text: "Done" } }],
              }),
            },
          }),
        },
      } as unknown as PaseoApi;
      const readAfterReload = handleAfterReload.mock.calls.find(
        ([contract]) => contract.name === "seat.labels",
      )![1];
      const reloadedSeat = async () =>
        (await readAfterReload({ agentIds: ["lead"] }, { paseo: host })).seats.lead;
      await vi.waitUntil(async () => (await reloadedSeat())?.["overmind.status"] === "IDLE");
      expect(await reloadedSeat()).toMatchObject({
        "overmind.task.status": "READY_FOR_REVIEW",
        "overmind.turn.id": "t3",
        "overmind.turn.outcome": "completed",
      });
      await reloaded();
    } finally {
      await cleanup();
      await rm(directory, { recursive: true, force: true });
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
