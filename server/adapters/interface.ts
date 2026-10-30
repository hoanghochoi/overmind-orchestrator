/** Roles understood by the Overmind SLP topology. */
export type DriverRole = "supervisor" | "lead" | "peer";
/** Backwards-compatible shorthand for callers that model the role separately. */
export type Role = DriverRole;

/** Filesystem and environment controls used when opening a role session. */
export interface RoleEnvironmentOptions {
  /** Override the host home in tests or an explicitly isolated daemon. */
  readonly homeDirectory?: string;
  /** Override the provider baseline TOML path. */
  readonly baselineConfigPath?: string;
  /** Extra TOML values applied before the mandatory role guardrails. */
  readonly roleOverlay?: Readonly<Record<string, unknown>>;
  /** Workspace ancestry participates in native skill discovery. */
  readonly cwd?: string;
}

export interface RoleEnvironment {
  readonly role: DriverRole;
  readonly roleHome: string;
  readonly configPath: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface InterruptPayload {
  reason: string;
  notification: string;
}

/**
 * Optional bridge used by an adapter to deliver an interrupt to Paseo.
 *
 * Keeping the bridge outside of the adapter means the package does not need
 * to know how a host identifies or transports an active session.  The default
 * generic adapter still supports numeric process ids as a POSIX fallback.
 */
export type InterruptSender = (
  sessionId: string,
  payload: InterruptPayload,
) => void | Promise<void>;

/**
 * Provider-neutral driver contract used by the Overmind provisioning layer.
 */
export interface ICliDriverAdapter {
  readonly driverName: string;

  /** Create the isolated role home and return the child-process environment. */
  buildSpawnEnv(
    role: DriverRole,
    options?: RoleEnvironmentOptions,
  ): Promise<Record<string, string>>;

  /** Return the provider-neutral model-catalog guardrails for a role. */
  getModelCatalogOptions(role: DriverRole): Readonly<Record<string, unknown>>;

  /** Normalize a provider's thought stream for the semantic sensor. */
  extractThoughtStream(rawOutput: string): string;

  /** Send a durable interrupt notification to a running provider session. */
  sendInterrupt(sessionId: string, payload: InterruptPayload): Promise<void>;
}
