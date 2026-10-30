import { AgyCliAdapter } from "./agy.js";
import { ClaudeCliAdapter } from "./claude.js";
import { CodexCliAdapter } from "./codex.js";
import { GenericCliAdapter } from "./generic.js";
import type { ICliDriverAdapter } from "./interface.js";
import { OpenCodeCliAdapter } from "./opencode.js";
import { PiCliAdapter } from "./pi.js";

function normalizeDriverName(driverName: string): string {
  return driverName.trim().toLowerCase();
}

/** Runtime registry for built-in and third-party Paseo driver adapters. */
export class DriverRegistry {
  private static readonly adapters = new Map<string, ICliDriverAdapter>();
  private static readonly genericAdapter = new GenericCliAdapter();

  static {
    this.register("codex", new CodexCliAdapter());
    this.register("claude", new ClaudeCliAdapter());
    this.register("opencode", new OpenCodeCliAdapter());
    this.register("pi", new PiCliAdapter());
    this.register("agy", new AgyCliAdapter());
    this.register("generic", this.genericAdapter);
  }

  public static register(driverName: string, adapter: ICliDriverAdapter): void {
    const normalized = normalizeDriverName(driverName);
    if (normalized.length === 0) throw new TypeError("driverName must not be empty");
    if (!adapter || typeof adapter.buildSpawnEnv !== "function") {
      throw new TypeError(`Invalid adapter registered for '${driverName}'`);
    }
    this.adapters.set(normalized, adapter);
  }

  public static getAdapter(driverName: string): ICliDriverAdapter {
    const normalized = normalizeDriverName(driverName);
    const adapter = this.adapters.get(normalized);
    if (adapter) return adapter;
    console.warn(
      `[Overmind] Driver '${driverName}' not explicitly registered. Falling back to GenericCliAdapter.`,
    );
    return this.genericAdapter;
  }

  public static has(driverName: string): boolean {
    return this.adapters.has(normalizeDriverName(driverName));
  }

  public static unregister(driverName: string): boolean {
    const normalized = normalizeDriverName(driverName);
    if (normalized === "generic") return false;
    return this.adapters.delete(normalized);
  }

  public static list(): readonly string[] {
    return [...this.adapters.keys()];
  }
}

export default DriverRegistry;
