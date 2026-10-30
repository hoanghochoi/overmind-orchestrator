import type {
  DriverRole,
  ICliDriverAdapter,
  InterruptPayload,
  InterruptSender,
  RoleEnvironmentOptions,
} from "./interface.js";
import {
  prepareRoleEnvironment,
  roleEnvironment,
  roleModelCatalogOptions,
} from "./role-environment.js";
import { assertInterRoleMessage } from "../../shared/modules/inter_role.js";

export interface GenericCliAdapterOptions {
  /** Override the name when building a small adapter for another CLI. */
  driverName?: string;
  /** Host bridge for non-POSIX session identifiers. */
  interruptSender?: InterruptSender;
}

// oxlint-disable-next-line no-control-regex -- ANSI terminal sequences are the input being stripped.
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

/** Remove terminal control sequences while preserving the provider's text. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replaceAll("\r", "");
}

function textFromJson(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(textFromJson).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join("") : null;
  }
  if (value === null || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of ["text", "delta", "content", "message", "output"]) {
    const text = textFromJson(record[key]);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Normalize plain text and common JSONL provider events into sensor input.
 * Unknown JSON is retained verbatim so diagnostics are not silently lost.
 */
export function normalizeThoughtStream(rawOutput: string): string {
  const cleaned = stripAnsi(rawOutput);
  if (cleaned.length === 0) return "";

  const lines = cleaned.split("\n");
  let parsedAny = false;
  const normalized = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return line;

    try {
      const value: unknown = JSON.parse(trimmed);
      const text = textFromJson(value);
      if (text === null) return line;
      parsedAny = true;
      return text;
    } catch {
      return line;
    }
  });

  return parsedAny ? normalized.join("\n") : cleaned;
}

/**
 * Prepares a role's isolated home and environment. Paseo launches the provider
 * itself, so runtime limits travel through the profile and agent config instead.
 */
export class GenericCliAdapter implements ICliDriverAdapter {
  readonly driverName: string;
  private readonly interruptSender?: InterruptSender;

  constructor(options: GenericCliAdapterOptions = {}) {
    this.driverName = options.driverName?.trim() || "generic";
    this.interruptSender = options.interruptSender;
  }

  async buildSpawnEnv(
    role: DriverRole,
    options: RoleEnvironmentOptions = {},
  ): Promise<Record<string, string>> {
    return { ...(await prepareRoleEnvironment(this.driverName, role, options)).env };
  }

  getRoleEnvironment(role: DriverRole, options: RoleEnvironmentOptions = {}) {
    return roleEnvironment(this.driverName, role, options);
  }

  getModelCatalogOptions(role: DriverRole): Readonly<Record<string, unknown>> {
    return roleModelCatalogOptions(role);
  }

  extractThoughtStream(rawOutput: string): string {
    return normalizeThoughtStream(rawOutput);
  }

  async sendInterrupt(sessionId: string, payload: InterruptPayload): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (normalizedSessionId.length === 0) {
      throw new TypeError("sessionId must not be empty");
    }
    assertInterRoleMessage(payload.reason, "interrupt reason");
    assertInterRoleMessage(payload.notification, "interrupt notification");

    if (this.interruptSender) {
      await this.interruptSender(normalizedSessionId, payload);
      return;
    }

    // A plain PID is the only transport that can be handled without Paseo's
    // session bridge.  Do not claim success for opaque ids.
    const pid = Number(normalizedSessionId);
    const processLike = (
      globalThis as typeof globalThis & {
        process?: { kill?: (pid: number, signal: string) => void };
      }
    ).process;
    if (Number.isSafeInteger(pid) && pid > 0 && typeof processLike?.kill === "function") {
      processLike.kill(pid, "SIGINT");
      return;
    }

    throw new Error(
      `No interrupt transport configured for ${this.driverName} session '${normalizedSessionId}'`,
    );
  }
}

export default GenericCliAdapter;
export { GenericCliAdapter as GenericAdapter };
