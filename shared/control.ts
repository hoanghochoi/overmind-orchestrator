import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { overmindSettings } from "./settings.js";

export const ProfileStatusSchema = z.object({
  role: z.string(),
  id: z.string(),
  label: z.string(),
  status: z.enum(["ready", "unconfigured", "missing", "error"]),
  error: z.string().nullable(),
});
export const AlertSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  timestamp: z.string(),
  // hybrid: a regex candidate that the semantic check confirmed; score is that similarity.
  // structural: derived from what the turn did, such as a completion claim without a check.
  tier: z.enum(["regex", "semantic", "hybrid", "structural"]),
  score: z.number(),
  patterns: z.array(z.string()),
  antiPatterns: z.array(z.string()).default([]),
  excerpt: z.string(),
  supervisorDelivery: z
    .object({
      status: z.enum(["sent", "queued", "missing", "failed"]),
      agentId: z.string().nullable(),
      error: z.string().nullable(),
    })
    .default({ status: "queued", agentId: null, error: null }),
  supervisorNotified: z.boolean().default(false),
  jev: z
    .object({
      choice: z.enum(["normal", "review", "insufficient"]),
      confidence: z.number(),
      probability: z.number(),
      verdict: z.enum(["review", "uncertain", "normal"]),
    })
    .nullable(),
  error: z.string().nullable(),
});
export const DetectionEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  agentId: z.string(),
  title: z.string(),
  role: z.string().nullable(),
  turnId: z.string().nullable(),
  stage: z.enum(["live", "turn-end", "escalation"]),
  patterns: z.array(z.string()),
  antiPatterns: z.array(z.string()).default([]),
  matched: z.string(),
  semanticScore: z.number().nullable(),
  threshold: z.number(),
  confirmed: z.boolean(),
  jev: z.string().nullable(),
  error: z.string().nullable(),
});
export const syncProviders = defineRpc({
  name: "providers.sync",
  input: z.object({}),
  output: z.object({ profiles: z.array(ProfileStatusSchema) }),
});
export const controlStatus = defineRpc({
  name: "control.status",
  input: z.object({}),
  output: z.object({
    profiles: z.array(ProfileStatusSchema),
    mode: z.string(),
    embeddingModel: z.string(),
    builtinModel: z.object({
      status: z.enum(["idle", "downloading", "ready", "error"]),
      progress: z.number(),
      error: z.string().nullable(),
    }),
    jevEnabled: z.boolean(),
    lastCheckedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    alerts: z.array(AlertSchema),
  }),
});
export const testJev = defineRpc({
  name: "jev.test",
  input: overmindSettings.schema.shape.jev,
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    model: z.string(),
    latencyMs: z.number(),
    models: z.array(z.string()),
  }),
});
export const testEmbedding = defineRpc({
  name: "embedding.test",
  input: overmindSettings.schema.shape.detection.unwrap().shape.embedding,
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    dimensions: z.number(),
    models: z.array(z.string()),
  }),
});
export const NotebookEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  workspaceId: z.string(),
  observation: z.string(),
  suspectedMechanism: z.string(),
  impact: z.string(),
  recommendation: z.string(),
  antiPattern: z.string().nullable(),
  protocolCandidate: z.boolean(),
  evidenceCount: z.number(),
});
/** A Lead or Peer task as last seen, kept in `<project>/.overmind/tasks.json` after archive. */
export const TaskRecordSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  status: z.string(),
  workspaceId: z.string().nullable(),
  lastUserMessageAt: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
/** Owner-side read of every project's task history and Supervisor notebook. */
export const projectHistory = defineRpc({
  name: "project.history",
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({
        name: z.string(),
        rootPath: z.string(),
        tasks: z.array(TaskRecordSchema),
        notebook: z.array(NotebookEntrySchema),
      }),
    ),
    errors: z.array(z.string()),
  }),
});
/** Owner review of a specific completed turn; model completion never accepts a task. */
export const reviewTask = defineRpc({
  name: "task.review",
  input: z.object({
    agentId: z.string().min(1),
    turnId: z.string().min(1),
    decision: z.enum(["accepted", "reopened"]),
    evidence: z.string().trim().min(1, "Review evidence is required").max(4000),
  }),
  output: z.object({ agentId: z.string(), labels: z.record(z.string(), z.string()) }),
});
/** Plugin-owned Overmind labels; the UI lays them over each agent's own labels. */
export const seatLabels = defineRpc({
  name: "seat.labels",
  input: z.object({ agentIds: z.array(z.string().min(1)).max(500) }),
  output: z.object({ seats: z.record(z.string(), z.record(z.string(), z.string())) }),
});
/** A host image an agent linked in its chat, for the command console. */
export const readImage = defineRpc({
  name: "chat.image",
  input: z.object({ path: z.string().min(1).max(4096) }),
  output: z.object({ dataUri: z.string() }),
});
export const embeddingModels = defineRpc({
  name: "embedding.models",
  input: z.object({ baseUrl: z.url() }),
  output: z.object({ models: z.array(z.string()) }),
});
export type ProfileStatus = z.output<typeof ProfileStatusSchema>;
export type OvermindAlert = z.output<typeof AlertSchema>;
export type OvermindNotebookEntry = z.output<typeof NotebookEntrySchema>;
export type TaskRecord = z.output<typeof TaskRecordSchema>;
export type DetectionEntry = z.output<typeof DetectionEntrySchema>;
