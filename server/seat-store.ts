import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const fileSchema = z.object({
  version: z.literal(1),
  seats: z.record(z.string(), z.record(z.string(), z.string())),
});

/**
 * Overmind labels owned by the plugin. Released Paseo hosts let plugins set agent
 * labels only at creation, so turn, review and contract state lives here and the
 * UI overlays it on the agent's own labels.
 */
export class SeatStore {
  private seats: Record<string, Record<string, string>> = {};
  private loaded: Promise<void> | undefined;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private load(): Promise<void> {
    this.loaded ??= readFile(this.path, "utf8").then(
      (text) => {
        this.seats = fileSchema.parse(JSON.parse(text)).seats;
        return undefined;
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    return this.loaded;
  }

  async get(agentId: string): Promise<Record<string, string>> {
    await this.load();
    return { ...this.seats[agentId] };
  }

  async getMany(agentIds: readonly string[]): Promise<Record<string, Record<string, string>>> {
    await this.load();
    return Object.fromEntries(
      agentIds.filter((id) => this.seats[id]).map((id) => [id, { ...this.seats[id] }]),
    );
  }

  /** Merge labels; an empty value removes the key, like a cleared agent label. */
  async merge(agentId: string, labels: Record<string, string>): Promise<Record<string, string>> {
    await this.load();
    const next = { ...this.seats[agentId] };
    for (const [key, value] of Object.entries(labels)) {
      if (value) next[key] = value;
      else delete next[key];
    }
    if (Object.keys(next).length) this.seats[agentId] = next;
    else delete this.seats[agentId];
    await this.save();
    return { ...next };
  }

  private save(): Promise<unknown> {
    const snapshot = JSON.stringify({ version: 1, seats: this.seats });
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

  async flush(): Promise<void> {
    await this.saving;
  }
}
