import type { PaseoApi } from "@getpaseo/client";
import { ProviderOverrideSchema, type ProviderOverride } from "@getpaseo/protocol/provider-config";
import { OVERMIND_PROFILES, PEER_KIND_PREFIX, type ProfileRole } from "../shared/providers.js";
import type { OvermindSettings, RoleBinding } from "../shared/settings.js";
import type { ProfileStatus } from "../shared/control.js";

const NATIVE_BASES = new Set(["claude", "codex", "copilot", "opencode", "pi", "omp", "acp"]);
const OWNER = "paseo-plugin-overmind";
const ROLES = ["supervisor", "lead", "peer"] as const;
const ENFORCED_DRIVERS = new Set(["claude", "codex", "opencode", "pi", "agy"]);
// Seats coordinate only through the plugin's checked Overmind tools, never the raw Paseo tools.
const SEAT_PASEO_TOOLS = { enabled: false };
// Claude's native sub-agent tools; every child must be a real Paseo agent.
const CLAUDE_SUBAGENT_TOOLS = ["Task", "Agent"];
const CLAUDE_WRITE_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash"];

/**
 * Runtime limits Paseo applies to every session of the profile, on create and resume.
 * Profile `options` outrank the permission mode a seat runs in, so a Supervisor stays
 * read-only even when Settings picks full access.
 */
function enforcedOverrides(
  role: ProfileRole,
  baseId: string,
  base: ProviderOverride,
): Pick<ProviderOverride, "options" | "disallowedTools"> {
  if (baseId === "codex" && role === "supervisor")
    return { options: { ...base.options, sandbox_mode: "read-only" } };
  if (baseId === "claude")
    return {
      disallowedTools: [
        ...new Set([
          ...(base.disallowedTools ?? []),
          ...CLAUDE_SUBAGENT_TOOLS,
          ...(role === "supervisor" ? CLAUDE_WRITE_TOOLS : []),
        ]),
      ],
    };
  return {};
}

/** The same limits per agent, for a seat created before its profile is republished. */
export function enforcedProviderOptions(
  role: ProfileRole,
  driver: string,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const current = Array.isArray(options.disallowedTools)
    ? (options.disallowedTools as string[])
    : undefined;
  const enforced = enforcedOverrides(role, driver, { disallowedTools: current });
  return {
    ...options,
    ...enforced.options,
    ...(enforced.disallowedTools ? { disallowedTools: enforced.disallowedTools } : {}),
  };
}

function isEnforced(role: ProfileRole, entry: ProviderOverride): boolean {
  const baseId = entry.extends ?? "";
  const wanted = enforcedOverrides(role, baseId, {});
  if (wanted.options?.sandbox_mode && entry.options?.sandbox_mode !== wanted.options.sandbox_mode)
    return false;
  return (wanted.disallowedTools ?? []).every((tool) => entry.disallowedTools?.includes(tool));
}

/**
 * Paseo merges patches, so an override the old source set cannot be cleared by patching.
 * Such a profile is removed first and registered again from the new source.
 */
function hasStaleOverrides(current: ProviderOverride, base: ProviderOverride): boolean {
  for (const key of ["command", "options", "params", "disallowedTools", "paseoTools"] as const)
    if (current[key] !== undefined && JSON.stringify(current[key]) !== JSON.stringify(base[key]))
      return true;
  return Object.keys(current.env ?? {}).some(
    (key) => !key.startsWith("OVERMIND_") && !(key in (base.env ?? {})),
  );
}

/** One Paseo profile Overmind registers per role. */
interface ProfileSlot {
  role: ProfileRole;
  id: string;
  label: string;
  binding: RoleBinding;
}

function profileSlots(values: OvermindSettings): ProfileSlot[] {
  return ROLES.map((role) => ({
    role,
    id: OVERMIND_PROFILES[role].id,
    label: OVERMIND_PROFILES[role].label,
    binding: values[role],
  }));
}

function profileResult(
  slot: Pick<ProfileSlot, "role" | "id" | "label">,
  status: ProfileStatus["status"],
  error: string | null = null,
): ProfileStatus {
  return { role: slot.role, id: slot.id, label: slot.label, status, error };
}

/**
 * The CLI that enforces a profile's limits. An ACP provider is identified by its command:
 * agy-acp runs the Antigravity CLI, which reads the role home and its hooks.
 */
function driverOf(baseId: string, base: ProviderOverride): string {
  const program = base.command?.[0]?.split(/[\\/]/u).pop() ?? "";
  return baseId === "acp" && /^agy-acp(?:\.exe)?$/iu.test(program) ? "agy" : baseId;
}

function assertNativeBase(
  role: ProfileRole,
  baseId: string,
  base: ProviderOverride,
  provider: string,
) {
  if (!NATIVE_BASES.has(baseId))
    throw new Error(
      `Paseo 0.13 chưa hỗ trợ profile kế thừa provider plugin ${provider}. Dùng provider ACP (vd. agy-acp) hoặc chọn provider này cho Scout/Preview.`,
    );
  const driver = driverOf(baseId, base);
  if (!ENFORCED_DRIVERS.has(driver))
    throw new Error(
      `Overmind chưa có adapter đảm bảo giới hạn S-L-P cho ${driver}. Chọn Claude, Codex, OpenCode, Pi hoặc agy-acp.`,
    );
  // AGY limits are a web-tool hook only; it has no read-only mode or sub-agent switch.
  if (driver === "agy" && role !== "peer") throw new Error("agy-acp chỉ dùng được cho Peer.");
}

export async function profileStatuses(
  paseo: PaseoApi,
  values: OvermindSettings,
): Promise<ProfileStatus[]> {
  const { config } = await paseo.config.get();
  return profileSlots(values).map((slot) => {
    const { role, binding } = slot;
    const entry = ProviderOverrideSchema.parse(config.providers[slot.id] ?? {});
    const model = entry.models?.[0];
    const thinking = model?.thinkingOptions?.find((option) => option.isDefault)?.id ?? "";
    const matches =
      entry.env?.OVERMIND_PROFILE_OWNER === OWNER &&
      entry.env.OVERMIND_SOURCE_PROVIDER === binding.provider &&
      entry.enabled !== false &&
      entry.paseoTools?.enabled === false &&
      isEnforced(role, entry) &&
      model?.id === binding.model &&
      thinking === binding.thinkingOptionId;
    if (!binding.provider) return profileResult(slot, "unconfigured");
    return profileResult(slot, matches ? "ready" : "missing");
  });
}

export async function publishProfiles(
  paseo: PaseoApi,
  values: OvermindSettings,
): Promise<ProfileStatus[]> {
  const { config } = await paseo.config.get();
  const updates: Record<string, ProviderOverride> = {};
  const slots = profileSlots(values);
  // Peer kinds were removed; disable their old profiles so nobody creates from them.
  for (const [id, raw] of Object.entries(config.providers)) {
    const entry = ProviderOverrideSchema.parse(raw ?? {});
    if (
      id.startsWith(PEER_KIND_PREFIX) &&
      entry.env?.OVERMIND_PROFILE_OWNER === OWNER &&
      entry.enabled !== false
    )
      updates[id] = { enabled: false };
  }
  const results = await Promise.all(
    slots.map(async (slot): Promise<ProfileStatus> => {
      const { role, binding } = slot;
      const profile = slot;
      const current = ProviderOverrideSchema.parse(config.providers[profile.id] ?? {});
      try {
        if (config.providers[profile.id] && current.env?.OVERMIND_PROFILE_OWNER !== OWNER)
          throw new Error(`ID ${profile.id} đã thuộc cấu hình khác; không ghi đè.`);
        if (!binding.provider) {
          if (config.providers[profile.id]) updates[profile.id] = { enabled: false };
          return profileResult(slot, "unconfigured");
        }
        if (binding.provider.startsWith("overmind-"))
          throw new Error("Chọn provider gốc, không chọn lại profile Overmind.");
        const base = ProviderOverrideSchema.parse(config.providers[binding.provider] ?? {});
        const baseId = base.extends ?? binding.provider;
        assertNativeBase(role, baseId, base, binding.provider);
        const enforced = enforcedOverrides(role, baseId, base);
        const catalog = await paseo.providers.listModels(binding.provider);
        if (catalog.error) throw new Error(catalog.error);
        const model = catalog.models?.find(
          (entry) => entry.id === binding.model && entry.isSelectable !== false,
        );
        if (!model)
          throw new Error(`Model ${binding.model} không còn khả dụng cho ${binding.provider}.`);
        if (
          binding.thinkingOptionId &&
          !model.thinkingOptions?.some((option) => option.id === binding.thinkingOptionId)
        )
          throw new Error("Thinking không có trong catalog của model.");
        updates[profile.id] = {
          ...base,
          ...enforced,
          extends: baseId,
          enabled: true,
          paseoTools: SEAT_PASEO_TOOLS,
          label: profile.label,
          description: `${profile.label} · ${binding.provider}/${binding.model}`,
          env: {
            ...base.env,
            OVERMIND_PROFILE_OWNER: OWNER,
            OVERMIND_SOURCE_PROVIDER: binding.provider,
            OVERMIND_ROLE: role,
          },
          models: [
            {
              id: model.id,
              label: model.label,
              isDefault: true,
              thinkingOptions: model.thinkingOptions?.map((option) => ({
                id: option.id,
                label: option.label,
                description: option.description,
                isDefault: option.id === binding.thinkingOptionId,
              })),
            },
          ],
          additionalModels: [],
        };
        return profileResult(slot, "ready");
      } catch (error) {
        return profileResult(slot, "error", error instanceof Error ? error.message : String(error));
      }
    }),
  );
  if (Object.keys(updates).length) {
    try {
      // A profile switching source drops the old source's overrides before it is rewritten.
      const removeProviders = Object.keys(updates).filter(
        (id) =>
          updates[id]!.extends &&
          hasStaleOverrides(ProviderOverrideSchema.parse(config.providers[id] ?? {}), updates[id]!),
      );
      if (removeProviders.length) await paseo.config.patch({ removeProviders });
      await paseo.config.patch({ providers: updates });
    } catch (error) {
      return results.map((result) =>
        updates[result.id]
          ? {
              ...result,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            }
          : result,
      );
    }
  }
  const observed = await profileStatuses(paseo, values);
  for (const result of results) {
    if (result.status !== "ready") continue;
    const actual = observed.find((status) => status.id === result.id);
    if (actual?.status !== "ready") {
      result.status = "error";
      result.error = "Daemon chưa áp dụng profile đúng model/thinking. Thử đăng ký lại.";
    }
  }
  return results;
}

export async function resolveDriver(paseo: PaseoApi, provider: string): Promise<string> {
  const { config } = await paseo.config.get();
  const entry = ProviderOverrideSchema.parse(config.providers[provider] ?? {});
  return entry.extends ? driverOf(entry.extends, entry) : (provider.split("/", 1)[0] ?? provider);
}

/** A registered profile a Supervisor or Lead can create a seat from. */
export interface SeatProfile {
  role: ProfileRole;
  /** The Overmind profile id. */
  provider: string;
  model: string;
  /** Thinking levels the model offers; the agent's effort is one of them. */
  efforts: string[];
  defaultEffort: string | null;
  /** The provider and model the profile runs on. */
  source: string;
}

export async function seatProfiles(
  paseo: PaseoApi,
  values: OvermindSettings,
): Promise<SeatProfile[]> {
  const { config } = await paseo.config.get();
  return profileSlots(values).flatMap((slot): SeatProfile[] => {
    const { binding } = slot;
    const entry = ProviderOverrideSchema.parse(config.providers[slot.id] ?? {});
    if (!config.providers[slot.id] || entry.enabled === false) return [];
    if (!binding.provider || !binding.model) return [];
    return [
      {
        role: slot.role,
        provider: slot.id,
        model: binding.model,
        efforts: entry.models?.[0]?.thinkingOptions?.map((option) => option.id) ?? [],
        defaultEffort: binding.thinkingOptionId || null,
        source: `${binding.provider}/${binding.model}`,
      },
    ];
  });
}
