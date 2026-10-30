import type {
  PaseoApi,
  PaseoProviderModelsResult,
  PaseoProviderModesResult,
} from "@getpaseo/client";
import { settingsRpc, type RpcInput, type RpcOutput } from "@getpaseo/plugin";
import {
  controlStatus,
  embeddingModels,
  syncProviders,
  testEmbedding,
  testJev,
} from "../shared/control.js";
import { roleForProvider } from "../shared/providers.js";
import { overmindSettings, type OvermindSettings, type RoleBinding } from "../shared/settings.js";

export const PROVIDER_SLOTS = ["supervisor", "lead", "peer", "scout", "preview"] as const;
export type ProviderSlot = (typeof PROVIDER_SLOTS)[number];
/** Slots whose permission mode is applied when Overmind creates the seat. */
export const SEAT_SLOTS = ["supervisor", "lead", "peer"] as const;
export type ModeSlot = (typeof SEAT_SLOTS)[number];
export function slotValue(values: OvermindSettings, slot: ProviderSlot): RoleBinding {
  return values[slot];
}
function withSlot(
  values: OvermindSettings,
  slot: ProviderSlot,
  patch: Partial<RoleBinding>,
): OvermindSettings {
  return { ...values, [slot]: { ...values[slot], ...patch } };
}
export type SetupModel = ReturnType<typeof openSetupForm>;
const rpc = settingsRpc(overmindSettings.id);
interface SetupDependencies {
  read(): Promise<RpcOutput<typeof rpc.read>>;
  write(input: RpcInput<typeof rpc.write>): Promise<RpcOutput<typeof rpc.write>>;
  providers: Pick<PaseoApi["providers"], "listAvailable" | "listModels" | "listModes">;
  syncProviders(input: RpcInput<typeof syncProviders>): Promise<RpcOutput<typeof syncProviders>>;
  status(input: RpcInput<typeof controlStatus>): Promise<RpcOutput<typeof controlStatus>>;
  testJev(input: RpcInput<typeof testJev>): Promise<RpcOutput<typeof testJev>>;
  testEmbedding(input: RpcInput<typeof testEmbedding>): Promise<RpcOutput<typeof testEmbedding>>;
  embeddingModels(
    input: RpcInput<typeof embeddingModels>,
  ): Promise<RpcOutput<typeof embeddingModels>>;
}
type Result<T> =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "ready"; result: T }
  | { status: "error"; error: string };
type CatalogState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; models: NonNullable<PaseoProviderModelsResult["models"]> };
type ModesState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; modes: NonNullable<PaseoProviderModesResult["modes"]> };
interface Draft {
  values: OvermindSettings;
  revision: string;
  catalogs: Partial<Record<ProviderSlot, CatalogState>>;
  modes: Partial<Record<ModeSlot, ModesState>>;
  providers: string[];
  providerError: string | null;
  providersLoading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  saved: boolean;
  profileError: string | null;
  syncingProfiles: boolean;
  /** The last registration finished; per-role results are in `profiles`. */
  profilesSynced: boolean;
  profiles: RpcOutput<typeof syncProviders>["profiles"];
  runtime: Result<RpcOutput<typeof controlStatus>>;
  jevTest: Result<RpcOutput<typeof testJev>>;
  jevModels: string[];
  embeddingTest: Result<RpcOutput<typeof testEmbedding>>;
  ollamaModels: Result<string[]>;
  extraPatternsText: string;
  referencesText: string;
  numbers: { threshold: string; minConfidence: string; probabilityThreshold: string };
}
type SetupState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | ({ status: "ready" } & Draft);
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function lines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Each configured slot names a model, thinking and mode its live catalog offers. */
function assertSelections(draft: Draft, values: OvermindSettings): void {
  for (const slot of PROVIDER_SLOTS) {
    const value = slotValue(values, slot);
    if (!value.provider) continue;
    const catalog = draft.catalogs[slot];
    const model =
      catalog?.status === "ready"
        ? catalog.models.find((entry) => entry.id === value.model)
        : undefined;
    if (
      !model ||
      (value.thinkingOptionId &&
        !model.thinkingOptions?.some((option) => option.id === value.thinkingOptionId))
    )
      throw new Error(`Chọn model và thinking hợp lệ cho ${slot}.`);
  }
  for (const slot of SEAT_SLOTS) {
    const modes = draft.modes[slot];
    const { modeId } = slotValue(values, slot);
    if (modeId && modes?.status === "ready" && !modes.modes.some((mode) => mode.id === modeId))
      throw new Error(`Chọn quyền (mode) hợp lệ cho ${slot}.`);
  }
}

export function openSetupForm(deps: SetupDependencies) {
  let state: SetupState = { status: "loading" };
  let closed = false;
  let generation = 0;
  let jevTicket = 0;
  let embeddingTicket = 0;
  let ollamaTicket = 0;
  let refreshing = false;
  const requests: Partial<Record<ProviderSlot, number>> = {};
  const listeners = new Set<() => void>();
  function publish(next: SetupState) {
    if (closed) return;
    state = next;
    listeners.forEach((listener) => listener());
  }
  function edit(patch: Partial<Draft>) {
    if (state.status !== "ready" || state.saving) return;
    publish({
      ...state,
      ...patch,
      dirty: true,
      saved: false,
      error: null,
      profilesSynced: false,
    });
  }
  async function loadModels(slot: ProviderSlot) {
    if (state.status !== "ready") return;
    const { provider } = slotValue(state.values, slot);
    const ticket = (requests[slot] ?? 0) + 1;
    const openedGeneration = generation;
    requests[slot] = ticket;
    if (!provider) return;
    publish({ ...state, catalogs: { ...state.catalogs, [slot]: { status: "loading" } } });
    try {
      const result = await deps.providers.listModels(provider);
      if (result.error) throw new Error(result.error);
      if (state.status !== "ready" || requests[slot] !== ticket || generation !== openedGeneration)
        return;
      publish({
        ...state,
        catalogs: {
          ...state.catalogs,
          [slot]: {
            status: "ready",
            models: (result.models ?? []).filter((model) => model.isSelectable !== false),
          },
        },
      });
    } catch (error) {
      if (state.status !== "ready" || requests[slot] !== ticket || generation !== openedGeneration)
        return;
      publish({
        ...state,
        catalogs: { ...state.catalogs, [slot]: { status: "error", error: message(error) } },
      });
    }
  }
  async function loadModes(slot: ModeSlot) {
    if (state.status !== "ready") return;
    const { provider } = slotValue(state.values, slot);
    const openedGeneration = generation;
    if (!provider) return;
    publish({ ...state, modes: { ...state.modes, [slot]: { status: "loading" } } });
    let next: ModesState;
    try {
      const result = await deps.providers.listModes(provider);
      if (result.error) throw new Error(result.error);
      next = { status: "ready", modes: result.modes ?? [] };
    } catch (error) {
      next = { status: "error", error: message(error) };
    }
    // A provider change while loading makes this result stale.
    if (
      state.status === "ready" &&
      generation === openedGeneration &&
      slotValue(state.values, slot).provider === provider
    )
      publish({ ...state, modes: { ...state.modes, [slot]: next } });
  }
  async function loadProviders() {
    if (state.status !== "ready") return;
    const openedGeneration = generation;
    publish({ ...state, providersLoading: true, providerError: null });
    try {
      const result = await deps.providers.listAvailable();
      if (state.status !== "ready" || generation !== openedGeneration) return;
      publish({
        ...state,
        providersLoading: false,
        providers: result.providers
          .filter((entry) => entry.available && !roleForProvider(entry.provider))
          .map((entry) => entry.provider),
      });
    } catch (error) {
      if (state.status === "ready" && generation === openedGeneration)
        publish({ ...state, providersLoading: false, providerError: message(error) });
    }
  }
  async function refreshStatus() {
    if (state.status !== "ready" || refreshing) return;
    refreshing = true;
    const openedGeneration = generation;
    try {
      const result = await deps.status({});
      if (state.status === "ready" && generation === openedGeneration)
        publish({
          ...state,
          profiles: state.syncingProfiles ? state.profiles : result.profiles,
          runtime: { status: "ready", result },
        });
    } catch (error) {
      if (state.status === "ready" && generation === openedGeneration)
        publish({ ...state, runtime: { status: "error", error: message(error) } });
    } finally {
      refreshing = false;
    }
  }
  async function load() {
    closed = false;
    const openedGeneration = ++generation;
    publish({ status: "loading" });
    try {
      const result = await deps.read();
      if (closed || generation !== openedGeneration) return;
      if (result.status !== "ready") throw new Error(result.error);
      const values = overmindSettings.schema.parse(result.values);
      publish({
        status: "ready",
        values,
        revision: result.revision,
        catalogs: {},
        modes: {},
        providers: [],
        providerError: null,
        providersLoading: false,
        saving: false,
        dirty: false,
        error: null,
        saved: false,
        profileError: null,
        syncingProfiles: false,
        profilesSynced: false,
        profiles: [],
        runtime: { status: "pending" },
        jevTest: { status: "idle" },
        jevModels: ["jev-latest"],
        embeddingTest: { status: "idle" },
        ollamaModels: { status: "idle" },
        extraPatternsText: values.detection.extraPatterns.join("\n"),
        referencesText: values.detection.references.join("\n"),
        numbers: {
          threshold: String(values.detection.threshold),
          minConfidence: String(values.jev.minConfidence),
          probabilityThreshold: String(values.jev.probabilityThreshold),
        },
      });
      await Promise.all([
        loadProviders(),
        ...PROVIDER_SLOTS.map(loadModels),
        ...SEAT_SLOTS.map(loadModes),
        refreshStatus(),
      ]);
    } catch (error) {
      if (generation === openedGeneration) publish({ status: "error", error: message(error) });
    }
  }
  function patchSlot(slot: ProviderSlot, patch: Partial<RoleBinding>) {
    if (state.status !== "ready") return;
    edit({ values: withSlot(state.values, slot, patch) });
  }
  function validatedValues() {
    if (state.status !== "ready") throw new Error("Cấu hình chưa sẵn sàng.");
    const { numbers, values } = state;
    for (const [key, text] of Object.entries(numbers))
      if (!text.trim() || !Number.isFinite(Number(text)) || Number(text) < 0 || Number(text) > 1)
        throw new Error(`${key}: nhập số từ 0 đến 1.`);
    return overmindSettings.schema.parse({
      ...values,
      jev: {
        ...values.jev,
        minConfidence: Number(numbers.minConfidence),
        probabilityThreshold: Number(numbers.probabilityThreshold),
      },
      detection: {
        ...values.detection,
        extraPatterns: lines(state.extraPatternsText),
        references: lines(state.referencesText),
        threshold: Number(numbers.threshold),
      },
    });
  }
  async function publishProfiles() {
    if (state.status !== "ready" || state.syncingProfiles || state.dirty) return;
    const openedGeneration = generation;
    publish({ ...state, syncingProfiles: true, profileError: null, profilesSynced: false });
    try {
      const result = await deps.syncProviders({});
      if (state.status === "ready" && generation === openedGeneration)
        publish({
          ...state,
          syncingProfiles: false,
          profiles: result.profiles,
          profilesSynced: true,
        });
    } catch (error) {
      if (state.status === "ready" && generation === openedGeneration)
        publish({ ...state, syncingProfiles: false, profileError: message(error) });
    }
  }
  async function save() {
    if (state.status !== "ready" || state.saving || !state.dirty) return;
    let values: OvermindSettings;
    try {
      values = validatedValues();
      assertSelections(state, values);
    } catch (error) {
      publish({ ...state, error: message(error) });
      return;
    }
    const input = { values, revision: state.revision };
    const openedGeneration = generation;
    publish({ ...state, saving: true, error: null, saved: false });
    try {
      const result = await deps.write(input);
      if (result.status !== "saved") throw new Error(result.error);
      if (state.status !== "ready" || generation !== openedGeneration) return;
      publish({
        ...state,
        values: overmindSettings.schema.parse(result.values),
        revision: result.revision,
        saving: false,
        dirty: false,
        saved: true,
      });
      await publishProfiles();
      await refreshStatus();
    } catch (error) {
      if (state.status === "ready" && generation === openedGeneration)
        publish({ ...state, saving: false, error: message(error) });
    }
  }
  async function runJevTest() {
    if (state.status !== "ready" || state.jevTest.status === "pending") return;
    const ticket = ++jevTicket;
    const openedGeneration = generation;
    let input: OvermindSettings["jev"];
    try {
      if (!state.numbers.minConfidence.trim() || !state.numbers.probabilityThreshold.trim())
        throw new Error("Nhập confidence và probability từ 0 đến 1.");
      input = overmindSettings.schema.shape.jev.parse({
        ...state.values.jev,
        minConfidence: Number(state.numbers.minConfidence),
        probabilityThreshold: Number(state.numbers.probabilityThreshold),
      });
    } catch (error) {
      publish({ ...state, jevTest: { status: "error", error: message(error) } });
      return;
    }
    publish({ ...state, jevTest: { status: "pending" } });
    try {
      const result = await deps.testJev(input);
      if (state.status === "ready" && generation === openedGeneration && ticket === jevTicket)
        publish({
          ...state,
          jevTest: { status: "ready", result },
          jevModels: result.models.length ? result.models : state.jevModels,
        });
    } catch (error) {
      if (state.status === "ready" && generation === openedGeneration && ticket === jevTicket)
        publish({ ...state, jevTest: { status: "error", error: message(error) } });
    }
  }
  async function runEmbeddingTest() {
    if (state.status !== "ready" || state.embeddingTest.status === "pending") return;
    const ticket = ++embeddingTicket;
    const openedGeneration = generation;
    const input = { ...state.values.detection.embedding };
    publish({ ...state, embeddingTest: { status: "pending" } });
    try {
      const result = await deps.testEmbedding(input);
      if (state.status === "ready" && generation === openedGeneration && ticket === embeddingTicket)
        publish({ ...state, embeddingTest: { status: "ready", result } });
    } catch (error) {
      if (state.status === "ready" && generation === openedGeneration && ticket === embeddingTicket)
        publish({ ...state, embeddingTest: { status: "error", error: message(error) } });
    }
    await refreshStatus();
  }
  async function loadOllamaModels() {
    if (state.status !== "ready") return;
    const ticket = ++ollamaTicket;
    const openedGeneration = generation;
    const baseUrl = state.values.detection.embedding.baseUrl;
    publish({ ...state, ollamaModels: { status: "pending" } });
    try {
      const result = await deps.embeddingModels({ baseUrl });
      if (state.status === "ready" && generation === openedGeneration && ticket === ollamaTicket)
        publish({ ...state, ollamaModels: { status: "ready", result: result.models } });
    } catch (error) {
      if (state.status === "ready" && generation === openedGeneration && ticket === ollamaTicket)
        publish({ ...state, ollamaModels: { status: "error", error: message(error) } });
    }
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    loadProviders,
    loadModels,
    refreshStatus,
    save,
    publishProfiles,
    runJevTest,
    runEmbeddingTest,
    loadOllamaModels,
    selectProvider(slot: ProviderSlot, provider: string) {
      if (state.status !== "ready" || state.saving) return;
      patchSlot(slot, { provider, model: "", thinkingOptionId: "", modeId: "" });
      void loadModels(slot);
      if (isModeSlot(slot)) void loadModes(slot);
    },
    selectMode(slot: ModeSlot, modeId: string) {
      patchSlot(slot, { modeId });
    },
    selectModel(slot: ProviderSlot, model: string) {
      patchSlot(slot, { model, thinkingOptionId: "" });
    },
    selectThinking(slot: ProviderSlot, thinkingOptionId: string) {
      patchSlot(slot, { thinkingOptionId });
    },
    patchJev(patch: Partial<OvermindSettings["jev"]>) {
      if (state.status !== "ready") return;
      jevTicket++;
      edit({
        values: { ...state.values, jev: { ...state.values.jev, ...patch } },
        jevTest: { status: "idle" },
      });
    },
    patchDetection(patch: Partial<Omit<OvermindSettings["detection"], "embedding">>) {
      if (state.status !== "ready") return;
      edit({ values: { ...state.values, detection: { ...state.values.detection, ...patch } } });
    },
    patchEmbedding(patch: Partial<OvermindSettings["detection"]["embedding"]>) {
      if (state.status !== "ready") return;
      embeddingTicket++;
      if (patch.baseUrl !== undefined || patch.backend !== undefined) ollamaTicket++;
      edit({
        values: {
          ...state.values,
          detection: {
            ...state.values.detection,
            embedding: { ...state.values.detection.embedding, ...patch },
          },
        },
        embeddingTest: { status: "idle" },
        ollamaModels:
          patch.baseUrl !== undefined || patch.backend !== undefined
            ? { status: "idle" }
            : state.ollamaModels,
      });
    },
    setExtraPatterns(extraPatternsText: string) {
      edit({ extraPatternsText });
    },
    setReferences(referencesText: string) {
      edit({ referencesText });
    },
    setNumber(key: keyof Draft["numbers"], value: string) {
      if (state.status !== "ready") return;
      jevTicket++;
      edit({ numbers: { ...state.numbers, [key]: value }, jevTest: { status: "idle" } });
    },
    close() {
      closed = true;
      generation++;
      listeners.clear();
    },
  };
}

export function isModeSlot(slot: ProviderSlot): slot is ModeSlot {
  return (SEAT_SLOTS as readonly string[]).includes(slot);
}
