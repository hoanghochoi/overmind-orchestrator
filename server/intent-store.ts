import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const MAX_ENTRIES = 200;

const questionSchema = z.object({ id: z.string(), question: z.string(), askedAt: z.string() });
const entrySchema = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  humanQuotes: z.array(z.string()),
  recordedAt: z.string(),
});
const projectSchema = z.object({ open: z.array(questionSchema), entries: z.array(entrySchema) });
const fileSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), projectSchema),
});

export type IntentQuestion = z.infer<typeof questionSchema>;
export type IntentEntry = z.infer<typeof entrySchema>;
export type ProjectIntent = z.infer<typeof projectSchema>;

/** Project names compare loosely so "FirstBloom" and "firstbloom " are one project. */
function projectKey(project: string): string {
  return project.trim().toLowerCase();
}

/**
 * The Human's product intent per project: questions the Supervisor has put to the
 * Human and the answers it recorded with the Human's own words. It outlives any one
 * task, so later agreements and Lead decisions start from it instead of re-asking.
 */
export class IntentStore {
  private projects: Record<string, ProjectIntent> = {};
  private loaded: Promise<void> | undefined;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private load(): Promise<void> {
    this.loaded ??= readFile(this.path, "utf8").then(
      (text) => {
        this.projects = fileSchema.parse(JSON.parse(text)).projects;
        return undefined;
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    return this.loaded;
  }

  async read(project: string): Promise<ProjectIntent> {
    await this.load();
    const stored = this.projects[projectKey(project)] ?? { open: [], entries: [] };
    return { open: [...stored.open], entries: stored.entries.toReversed() };
  }

  async ask(project: string, questions: readonly string[]): Promise<IntentQuestion[]> {
    await this.load();
    const stored = this.project(project);
    const askedAt = new Date().toISOString();
    const added = questions.map((question) => ({ id: randomUUID(), question, askedAt }));
    stored.open.push(...added);
    await this.save();
    return added;
  }

  /** Records answers and closes the open questions they answer. */
  async record(
    project: string,
    answers: readonly Omit<IntentEntry, "id" | "recordedAt">[],
    closes: readonly string[],
  ): Promise<IntentEntry[]> {
    await this.load();
    const stored = this.project(project);
    const recordedAt = new Date().toISOString();
    const added = answers.map((answer) => ({ ...answer, id: randomUUID(), recordedAt }));
    stored.entries = [...stored.entries, ...added].slice(-MAX_ENTRIES);
    stored.open = stored.open.filter((question) => !closes.includes(question.id));
    await this.save();
    return added;
  }

  /** Open questions across every project, for the Supervisor card. */
  async openCount(): Promise<number> {
    await this.load();
    return Object.values(this.projects).reduce((total, project) => total + project.open.length, 0);
  }

  private project(project: string): ProjectIntent {
    const key = projectKey(project);
    this.projects[key] ??= { open: [], entries: [] };
    return this.projects[key];
  }

  private save(): Promise<unknown> {
    const snapshot = JSON.stringify({ version: 1, projects: this.projects });
    const saved = this.saving.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.path);
      return undefined;
    });
    this.saving = saved.catch(() => undefined);
    return saved;
  }
}
