import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DetectionEntrySchema, type DetectionEntry } from "../shared/control.js";

const MAX_LINES = 2000;

/**
 * Every candidate the sensor raises, confirmed or not. Agents review it on the
 * owner's request (the Supervisor's sensor_log tool) to tune rules and thresholds.
 */
export class DetectionLog {
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  record(entry: Omit<DetectionEntry, "id">): Promise<unknown> {
    const line = `${JSON.stringify({ ...entry, id: randomUUID() })}\n`;
    const written = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, { mode: 0o600 });
      const lines = (await readFile(this.path, "utf8")).split("\n").filter(Boolean);
      // shortcut: rewrites the file to trim it; move to rotation if review needs older history.
      if (lines.length > MAX_LINES * 1.5) {
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${lines.slice(-MAX_LINES).join("\n")}\n`, { mode: 0o600 });
        await rename(temporary, this.path);
      }
      return undefined;
    });
    this.writing = written.catch(() => undefined);
    return written;
  }

  async read(): Promise<DetectionEntry[]> {
    await this.writing;
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          return [];
        }
        const parsed = DetectionEntrySchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
  }

  /** Per-rule hit and confirmation counts for tuning. */
  static summarize(entries: readonly DetectionEntry[]) {
    const rules = new Map<string, { rule: string; hits: number; confirmed: number }>();
    for (const entry of entries)
      for (const rule of entry.patterns.length ? entry.patterns : ["semantic"]) {
        const stats = rules.get(rule) ?? { rule, hits: 0, confirmed: 0 };
        stats.hits++;
        if (entry.confirmed) stats.confirmed++;
        rules.set(rule, stats);
      }
    return [...rules.values()].sort((left, right) => right.hits - left.hits);
  }
}
