import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
export const NOTEBOOK_TOOLS = [
  "causal_notebook_write",
  "causal_notebook_read",
  "causal_notebook_propose_protocol",
] as const;
const text = z.string().trim().min(1).max(16_000);
export const CausalObservationSchema = z
  .object({
    workspace_id: z.string().min(1).max(200),
    session_id: z.string().min(1).max(200),
    observation: text,
    evidence: z
      .array(
        z
          .object({
            kind: z.enum([
              "quote",
              "timeline",
              "tool_output",
              "git_diff",
              "sensor",
              "reasoning_summary",
            ]),
            content: text,
            metadata: z.record(z.string(), z.json()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    suspected_mechanism: text,
    impact: text,
    recommendation: text,
    protocol_candidate: z.boolean(),
    anti_pattern: z.string().trim().min(1).max(200).optional(),
    alert_id: z.string().max(500).optional(),
  })
  .strict();
export const CausalEntrySchema = CausalObservationSchema.extend({
  id: z.uuid(),
  timestamp: z.iso.datetime(),
});
export type CausalObservation = z.infer<typeof CausalObservationSchema>;
export type CausalEntry = z.infer<typeof CausalEntrySchema>;
export interface NotebookPrincipal {
  provider: string;
  agentId: string;
}
export interface NotebookFilter {
  workspace_id?: string;
  anti_pattern?: string;
  keyword?: string;
}

export function assertNotebookSupervisor(principal: NotebookPrincipal): void {
  if (principal.provider !== "overmind-supervisor" || !principal.agentId)
    throw new Error("OVERMIND_NOTEBOOK_DENIED: Supervisor identity required");
}

const snapshotSchema = z
  .object({ version: z.literal(1), entries: z.array(CausalEntrySchema) })
  .strict();
const mutations = new Map<string, Promise<unknown>>();

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * One plugin owns writes; reload tears it down before starting its replacement.
 * The file lives in the plugin state directory, not the project, because Lead and
 * Peer keep file tools in the project and no per-tool rule stops `cat`.
 */
export class CausalNotebook {
  readonly path: string;
  /** Pre-move location; imported on first load and removed after the first save. */
  private readonly legacyPath: string;
  constructor(projectRoot: string, stateDirectory: string) {
    const id = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 32);
    this.path = join(stateDirectory, "notebooks", `${id}.md`);
    this.legacyPath = join(projectRoot, ".overmind", "notebook.md");
  }
  private async load(): Promise<CausalEntry[]> {
    const source = (await readIfExists(this.path)) ?? (await readIfExists(this.legacyPath));
    if (source === null) return [];
    const match = /^# Overmind Causal Notebook\n\n```json\n([\s\S]*)\n```\n$/.exec(source);
    if (!match) throw new Error("Invalid Causal Notebook; existing contents were preserved");
    return snapshotSchema.parse(JSON.parse(match[1])).entries;
  }
  private async save(entries: CausalEntry[]): Promise<void> {
    const directory = join(this.path, "..");
    await mkdir(directory, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          `# Overmind Causal Notebook\n\n\`\`\`json\n${JSON.stringify({ version: 1, entries }, null, 2)}\n\`\`\`\n`,
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await unlink(this.legacyPath).catch(() => undefined);
  }
  private mutate<T>(
    principal: NotebookPrincipal,
    operation: (entries: CausalEntry[]) => T,
  ): Promise<T> {
    assertNotebookSupervisor(principal);
    const pending = (mutations.get(this.path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const entries = await this.load();
        const result = operation(entries);
        await this.save(entries);
        return result;
      });
    mutations.set(this.path, pending);
    void pending
      .finally(() => {
        if (mutations.get(this.path) === pending) mutations.delete(this.path);
      })
      .catch(() => undefined);
    return pending;
  }
  /**
   * Read without a role principal, for the host's own UI. The owner already
   * has filesystem access to this file; the Supervisor check exists to keep
   * Lead and Peer *agents* out, not the person running the daemon.
   */
  async readForOwner(filter: NotebookFilter = {}): Promise<CausalEntry[]> {
    await mutations.get(this.path);
    return this.filterEntries(await this.load(), filter);
  }

  async read(principal: NotebookPrincipal, filter: NotebookFilter = {}): Promise<CausalEntry[]> {
    assertNotebookSupervisor(principal);
    await mutations.get(this.path);
    return this.filterEntries(await this.load(), filter);
  }

  private filterEntries(entries: CausalEntry[], filter: NotebookFilter): CausalEntry[] {
    return entries.filter(
      (entry) =>
        (!filter.workspace_id || entry.workspace_id === filter.workspace_id) &&
        (!filter.anti_pattern || entry.anti_pattern === filter.anti_pattern) &&
        (!filter.keyword ||
          JSON.stringify(entry).toLowerCase().includes(filter.keyword.toLowerCase())),
    );
  }
  write(
    principal: NotebookPrincipal,
    observation: CausalObservation,
    preserveReview = false,
  ): Promise<CausalEntry> {
    const value = CausalObservationSchema.parse(observation);
    return this.mutate(principal, (entries) => {
      const existing = value.alert_id
        ? entries.find((entry) => entry.alert_id === value.alert_id)
        : undefined;
      if (existing) {
        Object.assign(
          existing,
          preserveReview ? { evidence: value.evidence, observation: value.observation } : value,
        );
        return existing;
      }
      const entry = CausalEntrySchema.parse({
        ...value,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      });
      entries.push(entry);
      return entry;
    });
  }
  update(
    principal: NotebookPrincipal,
    id: string,
    observation: CausalObservation,
  ): Promise<CausalEntry> {
    const value = CausalObservationSchema.parse(observation);
    return this.mutate(principal, (entries) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry) throw new Error("Causal Notebook entry not found");
      Object.assign(entry, value);
      return entry;
    });
  }
  delete(principal: NotebookPrincipal, id: string): Promise<boolean> {
    return this.mutate(principal, (entries) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    });
  }
}
