import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_REFERENCES } from "./detection.js";
import { OVERMIND_PROFILES, roleForProvider } from "./providers.js";

const roleSettings = z
  .object({
    provider: z.string().default(""),
    model: z.string().default(""),
    thinkingOptionId: z.string().default(""),
    /** Provider permission mode for new agents; empty keeps the provider default. */
    modeId: z.string().default(""),
  })
  .default({ provider: "", model: "", thinkingOptionId: "", modeId: "" });

/** Host-scoped routing and local Overmind configuration. Provider logins stay managed by Paseo. */
export const overmindSettings = defineSettings({
  id: "control",
  scope: "host",
  version: 1,
  schema: z.object({
    supervisor: roleSettings,
    lead: roleSettings,
    peer: roleSettings,
    scout: roleSettings,
    preview: roleSettings,
    jev: z
      .object({
        apiKey: z.string().default(""),
        model: z.string().min(1).default("jev-latest"),
        enabled: z.boolean().default(false),
        minConfidence: z.number().min(0).max(1).default(0.6),
        probabilityThreshold: z.number().min(0).max(1).default(0.8),
      })
      .prefault({}),
    detection: z
      .object({
        mode: z.enum(["off", "regex", "hybrid", "semantic"]).default("hybrid"),
        includeDefaults: z.boolean().default(true),
        extraPatterns: z
          .array(z.string().min(1).max(256))
          .max(32)
          .default([])
          .superRefine((patterns, ctx) => {
            patterns.forEach((pattern, index) => {
              try {
                void new RegExp(pattern, "iu").source;
              } catch {
                ctx.addIssue({
                  code: "custom",
                  path: [index],
                  message: `Regex không hợp lệ: ${pattern}`,
                });
              }
            });
          }),
        references: z.array(z.string().min(1).max(1000)).min(1).max(24).default(DEFAULT_REFERENCES),
        threshold: z.number().min(0).max(1).default(0.7),
        embedding: z
          .object({
            backend: z.enum(["builtin", "ollama"]).default("builtin"),
            baseUrl: z.url().default("http://127.0.0.1:11434"),
            model: z.string().default(""),
          })
          .prefault({}),
      })
      .prefault({}),
  }),
});

export type OvermindSettings = z.output<typeof overmindSettings.schema>;
export type OvermindSeat = keyof Pick<OvermindSettings, "supervisor" | "lead" | "peer">;
export type OvermindProviderSlot = keyof Pick<OvermindSettings, "scout" | "preview">;
export type RoleBinding = OvermindSettings["peer"];

/** The settings an Overmind profile was registered from, or null when it is not configured. */
export function profileBinding(values: OvermindSettings, providerId: string): RoleBinding | null {
  const role = roleForProvider(providerId);
  return role && providerId === OVERMIND_PROFILES[role].id ? values[role] : null;
}
