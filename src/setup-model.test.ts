import { describe, expect, test, vi } from "vitest";
import { openSetupForm, type SetupModel } from "../client/setup-model.js";
import { overmindSettings } from "../shared/settings.js";

function fixture() {
  const values = overmindSettings.schema.parse({
    lead: { provider: "test", model: "model", thinkingOptionId: "" },
    jev: { apiKey: "existing-local-key" },
  });
  const read = vi.fn(async () => ({ status: "ready" as const, revision: "r1", values }));
  const write = vi.fn(async (input) => ({
    status: "saved" as const,
    revision: "r2",
    values: input.values,
  }));
  const listAvailable = vi.fn(async () => ({
    providers: [
      { provider: "test", available: true },
      { provider: "antigravity", available: true },
      { provider: "overmind-lead", available: true },
      { provider: "offline", available: false },
    ],
  }));
  const listModes = vi.fn(async () => ({
    modes: [
      { id: "default", label: "Default" },
      { id: "full-access", label: "Full access", description: "No approvals" },
    ],
  }));
  const listModels = vi.fn(async () => ({
    models: [
      { id: "model", label: "Test model" },
      { id: "hidden", label: "Hidden", isSelectable: false },
    ],
  }));
  const profiles = [
    {
      role: "lead",
      id: "overmind-lead",
      label: "Overmind Lead",
      status: "ready" as const,
      error: null,
    },
  ];
  const syncProviders = vi.fn(async () => ({ profiles }));
  const status = vi.fn(async () => ({
    profiles,
    mode: "hybrid",
    embeddingModel: "MiniLM",
    builtinModel: { status: "ready" as const, progress: 100, error: null },
    jevEnabled: false,
    lastCheckedAt: null,
    lastError: null,
    alerts: [],
  }));
  const testJev = vi.fn(async () => ({
    ok: true,
    message: "Validated",
    model: "jev-1",
    latencyMs: 10,
    models: ["jev-latest", "jev-1"],
  }));
  const testEmbedding = vi.fn(async () => ({
    ok: true,
    message: "Vector ready",
    dimensions: 384,
    models: ["all-minilm"],
  }));
  const embeddingModels = vi.fn(async () => ({
    models: ["all-minilm:latest", "qwen3-embedding:0.6b"],
  }));
  const model = openSetupForm({
    read,
    write,
    providers: { listAvailable, listModels, listModes },
    syncProviders,
    status,
    testJev,
    testEmbedding,
    embeddingModels,
  });
  return {
    model,
    read,
    write,
    listAvailable,
    listModels,
    listModes,
    values,
    syncProviders,
    status,
    testJev,
    testEmbedding,
    embeddingModels,
  };
}
function ready(model: SetupModel) {
  const state = model.getState();
  if (state.status !== "ready") throw new Error(`Expected ready, got ${state.status}`);
  return state;
}

describe("Overmind overview form", () => {
  test("keeps Antigravity, excludes Overmind aliases, and preserves a draft through catalog refresh", async () => {
    const f = fixture();
    await f.model.load();
    expect(f.listModels).toHaveBeenCalledExactlyOnceWith("test");
    expect(ready(f.model).providers).toEqual(["test", "antigravity"]);
    expect(ready(f.model).catalogs.lead).toMatchObject({
      status: "ready",
      models: [{ id: "model" }],
    });
    f.model.patchJev({ apiKey: "draft-key" });
    for (let i = 0; i < 10; i++) f.model.getState();
    expect(f.listModels).toHaveBeenCalledTimes(1);
    await f.model.loadModels("lead");
    expect(ready(f.model).values.jev.apiKey).toBe("draft-key");
  });
  test("saves the complete overview, publishes profiles after save, and advances revision", async () => {
    const f = fixture();
    await f.model.load();
    f.model.patchJev({ apiKey: "new-key" });
    f.model.setExtraPatterns("\\bwait\\b\n\\brethink\\b");
    await f.model.save();
    expect(f.write).toHaveBeenLastCalledWith({
      revision: "r1",
      values: {
        ...f.values,
        jev: { ...f.values.jev, apiKey: "new-key" },
        detection: { ...f.values.detection, extraPatterns: ["\\bwait\\b", "\\brethink\\b"] },
      },
    });
    expect(f.syncProviders).toHaveBeenCalledExactlyOnceWith({});
    expect(ready(f.model)).toMatchObject({
      saved: true,
      dirty: false,
      revision: "r2",
      profiles: [{ id: "overmind-lead", status: "ready" }],
    });
    f.model.patchJev({ apiKey: "next-key" });
    await f.model.save();
    expect(f.write.mock.lastCall?.[0].revision).toBe("r2");
  });
  test("keeps draft on conflict and never publishes unsaved config", async () => {
    const f = fixture();
    f.write.mockResolvedValueOnce({ status: "conflict", error: "Configuration changed" });
    await f.model.load();
    f.model.patchJev({ apiKey: "unsaved-key" });
    await f.model.save();
    expect(ready(f.model)).toMatchObject({
      dirty: true,
      saving: false,
      error: "Configuration changed",
      values: { jev: { apiKey: "unsaved-key" } },
    });
    expect(f.syncProviders).not.toHaveBeenCalled();
  });
  test("distinguishes a saved configuration from failed provider publication", async () => {
    const f = fixture();
    f.syncProviders.mockRejectedValueOnce(new Error("Reload rejected"));
    await f.model.load();
    f.model.patchJev({ enabled: true });
    await f.model.save();
    expect(ready(f.model)).toMatchObject({
      saved: true,
      dirty: false,
      error: null,
      profileError: "Reload rejected",
    });
    await f.model.publishProfiles();
    expect(ready(f.model).profileError).toBeNull();
  });
  test("rejects invalid regex, thresholds, and incomplete bindings before writing", async () => {
    const f = fixture();
    await f.model.load();
    f.model.setExtraPatterns("[");
    await f.model.save();
    expect(f.write).not.toHaveBeenCalled();
    expect(ready(f.model).error).toContain("Regex");
    f.model.setExtraPatterns("");
    f.model.setNumber("threshold", "");
    await f.model.save();
    expect(ready(f.model).error).toContain("threshold");
    f.model.setNumber("threshold", "0.8");
    f.model.selectModel("lead", "");
    await f.model.save();
    expect(ready(f.model).error).toContain("lead");
    f.model.selectModel("lead", "model");
    await f.model.save();
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  test("uses Scout catalog without SLP role and ignores stale provider responses", async () => {
    const f = fixture();
    await f.model.load();
    const slow = Promise.withResolvers<{ models: { id: string; label: string }[] }>();
    f.listModels.mockReturnValueOnce(slow.promise);
    f.model.selectProvider("scout", "old");
    f.model.selectProvider("scout", "antigravity");
    await vi.waitFor(() => expect(ready(f.model).catalogs.scout?.status).toBe("ready"));
    slow.resolve({ models: [{ id: "stale", label: "Stale" }] });
    await slow.promise;
    expect(f.listModels).toHaveBeenLastCalledWith("antigravity");
    expect(ready(f.model).catalogs.scout).toMatchObject({
      status: "ready",
      models: [{ id: "model" }],
    });
    expect(ready(f.model).values.scout).toEqual({
      provider: "antigravity",
      model: "",
      thinkingOptionId: "",
      modeId: "",
    });
  });
  test("tests JEV using draft key and thresholds without needing to save or enabling auto upload", async () => {
    const f = fixture();
    await f.model.load();
    f.model.patchJev({ apiKey: "draft-key" });
    f.model.setNumber("minConfidence", "0.75");
    await f.model.runJevTest();
    expect(f.testJev).toHaveBeenCalledExactlyOnceWith({
      ...f.values.jev,
      apiKey: "draft-key",
      minConfidence: 0.75,
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(ready(f.model).values.jev.enabled).toBe(false);
    expect(ready(f.model).jevModels).toContain("jev-1");
  });
  test("discovers local Ollama models, retains list after selection, and tests the draft model", async () => {
    const f = fixture();
    await f.model.load();
    f.model.patchEmbedding({ backend: "ollama", baseUrl: "http://localhost:11434" });
    await f.model.loadOllamaModels();
    expect(f.embeddingModels).toHaveBeenCalledExactlyOnceWith({
      baseUrl: "http://localhost:11434",
    });
    f.model.patchEmbedding({ model: "all-minilm:latest" });
    expect(ready(f.model).ollamaModels).toMatchObject({
      status: "ready",
      result: ["all-minilm:latest", "qwen3-embedding:0.6b"],
    });
    await f.model.runEmbeddingTest();
    expect(f.testEmbedding).toHaveBeenCalledExactlyOnceWith({
      backend: "ollama",
      baseUrl: "http://localhost:11434",
      model: "all-minilm:latest",
    });
    expect(ready(f.model).embeddingTest).toMatchObject({
      status: "ready",
      result: { dimensions: 384 },
    });
  });
  test("rejects stale Ollama discovery after changing endpoint", async () => {
    const f = fixture();
    await f.model.load();
    const slow = Promise.withResolvers<{ models: string[] }>();
    f.embeddingModels.mockReturnValueOnce(slow.promise);
    const loading = f.model.loadOllamaModels();
    f.model.patchEmbedding({ baseUrl: "http://localhost:11435" });
    slow.resolve({ models: ["old-host-model"] });
    await loading;
    expect(ready(f.model).ollamaModels).toEqual({ status: "idle" });
  });
  test("exposes read/catalog errors and allows retry", async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("Disconnected"));
    await f.model.load();
    expect(f.model.getState()).toEqual({ status: "error", error: "Disconnected" });
    f.listAvailable.mockRejectedValueOnce(new Error("Provider unavailable"));
    f.listModels.mockResolvedValueOnce({ error: "Catalog unavailable" });
    await f.model.load();
    expect(ready(f.model).providerError).toBe("Provider unavailable");
    expect(ready(f.model).catalogs.lead).toEqual({ status: "error", error: "Catalog unavailable" });
    await f.model.loadProviders();
    await f.model.loadModels("lead");
    expect(ready(f.model).providerError).toBeNull();
    expect(ready(f.model).catalogs.lead?.status).toBe("ready");
  });
  test("does not publish after closing and can reopen for React strict effects", async () => {
    const f = fixture();
    const read = Promise.withResolvers<Awaited<ReturnType<typeof f.read>>>();
    f.read.mockReturnValueOnce(read.promise);
    const listener = vi.fn();
    f.model.subscribe(listener);
    const loading = f.model.load();
    f.model.close();
    const callsAtClose = listener.mock.calls.length;
    read.resolve({ status: "ready", revision: "r1", values: f.values });
    await loading;
    expect(listener).toHaveBeenCalledTimes(callsAtClose);
    await f.model.load();
    expect(f.model.getState().status).toBe("ready");
  });
});
