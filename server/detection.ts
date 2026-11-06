import type { PaseoApi } from "@getpaseo/client";
import type { PaseoAgentTimelineEvent } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type {
  PluginHookAgent,
  PluginTurnOutcome,
} from "@getpaseo/plugin/server";
import type { OvermindSettings } from "../shared/settings.js";
import type { OvermindAlert } from "../shared/control.js";
import {
  ANTI_PATTERN_REFERENCES,
  ANTI_PATTERNS,
  CUSTOM_SIGNAL,
  DEFAULT_REGEX_RULES,
  type AntiPattern,
} from "../shared/detection.js";
import { isOvermindAgent } from "../shared/membership.js";
import { getParentAgentIdFromLabels as getParentAgentId } from "@getpaseo/protocol/agent-labels";
import {
  MailboxMiddleware,
  isAgentIdle,
} from "../shared/middleware/mailbox.js";
import { roleForProvider } from "../shared/providers.js";
import { configureEmbeddingRuntime, encodeTexts } from "./embedding.js";
import { evaluateJev } from "./jev.js";
import type { DetectionLog } from "./detection-log.js";
import {
  REPEAT_LIMIT,
  type Escalation,
  type RepetitionTracker,
} from "./repetition.js";
import { cosineSimilarity, OVERMIND_EVENT_ALERT } from "./hybrid_sensor.js";

// A command or tool call that checks the work: tests, type checks, lint or builds.
const VERIFICATION =
  /\b(?:tests?|vitest|jest|pytest|mocha|tsc|typecheck|lint|eslint|oxlint|cargo|go test|npm run|pnpm|yarn|mvn|gradle|make|build)\b/i;
// A statement that the work is finished or proven.
const COMPLETION_CLAIM =
  /\b(?:all tests pass(?:ed)?|tests? (?:now )?pass(?:es|ed|ing)?|(?:is|are|has been|have been) (?:now )?(?:fixed|done|complete|completed|resolved|verified)|implemented and verified)\b|đã (?:sửa xong|hoàn thành|xong|kiểm chứng)|test (?:đều )?pass/i;

export function latestExchange(items: readonly AgentTimelineItem[]) {
  let start = -1;
  for (let index = items.length - 1; index >= 0; index--)
    if (items[index].type === "user_message") {
      start = index;
      break;
    }
  const user = items[start];
  const turn = items.slice(start + 1);
  return {
    objective: user?.type === "user_message" ? user.text.slice(-4000) : "",
    output: turn
      .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
      .join("\n")
      .slice(-8000),
    /** Whether the turn ran anything that checks the work. */
    verified: turn.some(
      (item) =>
        item.type === "tool_call" && VERIFICATION.test(JSON.stringify(item))
    ),
  };
}

export interface Detection {
  tier: "regex" | "semantic" | "hybrid" | "structural";
  score: number;
  patterns: string[];
  antiPatterns: string[];
  /** The sentences that matched, or the scored output for a semantic-only signal. */
  matched: string;
  semanticScore: number | null;
  /** False for a regex candidate the semantic check rejected; it is logged, not alerted. */
  confirmed: boolean;
  error: string | null;
}

/** Sentences that match a rule, so the semantic check scores the claim, not the whole turn. */
export function matchRules(settings: OvermindSettings, output: string) {
  const rules = [
    ...(settings.detection.includeDefaults ? DEFAULT_REGEX_RULES : []),
    ...settings.detection.extraPatterns.map((source, index) => ({
      name: `custom-${index + 1}`,
      antiPattern: CUSTOM_SIGNAL,
      source,
    })),
  ].map((rule) => ({
    name: rule.name,
    antiPattern: rule.antiPattern,
    pattern: new RegExp(rule.source, "iu"),
  }));
  const patterns = new Set<string>();
  const antiPatterns = new Set<string>();
  const sentences: string[] = [];
  for (const sentence of output.split(/(?<=[.!?])\s+|\n+/)) {
    const hits = rules.filter((rule) => rule.pattern.test(sentence));
    if (!hits.length) continue;
    for (const hit of hits) {
      patterns.add(hit.name);
      antiPatterns.add(hit.antiPattern);
    }
    sentences.push(sentence.trim());
  }
  return patterns.size
    ? {
        patterns: [...patterns],
        antiPatterns: [...antiPatterns],
        context: [...new Set(sentences)].join(" … ").slice(-1000),
      }
    : null;
}

/** The built-in references plus the owner's, each tied to the anti-pattern it describes. */
function references(settings: OvermindSettings) {
  const builtIn = settings.detection.includeDefaults
    ? ANTI_PATTERN_REFERENCES
    : [];
  const known = new Map(
    ANTI_PATTERN_REFERENCES.map((entry) => [entry.text, entry.antiPattern])
  );
  const all = new Map<string, string>(
    builtIn.map((entry) => [entry.text, entry.antiPattern])
  );
  for (const text of settings.detection.references)
    if (!all.has(text)) all.set(text, known.get(text) ?? CUSTOM_SIGNAL);
  return [...all].map(([text, antiPattern]) => ({ text, antiPattern }));
}

async function semanticScore(
  settings: OvermindSettings,
  text: string,
  fetcher: typeof fetch
) {
  const candidates = references(settings);
  const [vector, ...vectors] = await encodeTexts(
    settings.detection.embedding,
    [text, ...candidates.map((candidate) => candidate.text)],
    fetcher
  );
  let best = { score: -Infinity, antiPattern: CUSTOM_SIGNAL as string };
  vectors.forEach((reference, index) => {
    const score = cosineSimilarity(vector, reference);
    if (score > best.score)
      best = { score, antiPattern: candidates[index]!.antiPattern };
  });
  return best;
}

/**
 * Regex proposes, the semantic model confirms. In hybrid mode a regex hit becomes an
 * alert only when the matched sentences resemble a reference problem; output without
 * a regex hit is still scored as a whole at the turn boundary.
 */
export async function detectOutput(
  settings: OvermindSettings,
  output: string,
  fetcher: typeof fetch = fetch,
  stage: "live" | "turn-end" = "turn-end"
): Promise<Detection | null> {
  const { mode, threshold } = settings.detection;
  if (mode === "off" || !output.trim()) return null;
  const regex = mode === "semantic" ? null : matchRules(settings, output);
  if (regex && mode === "regex")
    return {
      tier: "regex",
      score: 1,
      patterns: regex.patterns,
      antiPatterns: regex.antiPatterns,
      matched: regex.context,
      semanticScore: null,
      confirmed: true,
      error: null,
    };
  if (regex) {
    try {
      const { score } = await semanticScore(settings, regex.context, fetcher);
      return {
        tier: "hybrid",
        score,
        patterns: regex.patterns,
        antiPatterns: regex.antiPatterns,
        matched: regex.context,
        semanticScore: score,
        confirmed: score >= threshold,
        error: null,
      };
    } catch (error) {
      // Fail open: an unavailable model must not hide a stated blocker.
      return {
        tier: "regex",
        score: 1,
        patterns: regex.patterns,
        antiPatterns: regex.antiPatterns,
        matched: regex.context,
        semanticScore: null,
        confirmed: true,
        error: `Không chấm được ngữ nghĩa: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  if (mode === "regex" || stage === "live") return null;
  const { score, antiPattern } = await semanticScore(settings, output, fetcher);
  return score >= threshold
    ? {
        tier: "semantic",
        score,
        patterns: [],
        antiPatterns: [antiPattern],
        matched: output.slice(-500),
        semanticScore: score,
        confirmed: true,
        error: null,
      }
    : null;
}

/** A completion claim in a turn that ran no test, type check, lint or build. */
export function detectUnverifiedClaim(
  settings: OvermindSettings,
  exchange: { output: string; verified: boolean }
): Detection | null {
  if (
    settings.detection.mode === "off" ||
    !settings.detection.includeDefaults ||
    exchange.verified
  )
    return null;
  const claim = exchange.output
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => COMPLETION_CLAIM.test(sentence));
  if (!claim.length) return null;
  return {
    tier: "structural",
    score: 1,
    patterns: ["unverified-claim"],
    antiPatterns: ["weak-verification"],
    matched: claim.join(" … ").slice(-1000),
    semanticScore: null,
    confirmed: true,
    error: null,
  };
}

function antiPatternLabel(antiPattern: string): string {
  return ANTI_PATTERNS[antiPattern as AntiPattern] ?? antiPattern;
}

async function annotateJev(
  alert: OvermindAlert,
  settings: OvermindSettings,
  objective: string,
  output: string
) {
  if (!settings.jev.enabled) return;
  try {
    alert.jev = await evaluateJev(settings.jev, {
      objective,
      output,
      signals: alert.patterns,
    });
  } catch (error) {
    alert.error = error instanceof Error ? error.message : String(error);
  }
}

interface LiveTurn {
  turnId: string | null;
  output: string;
  objective: string;
  subscription: ReturnType<
    ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["subscribe"]
  > | null;
  emitted: Set<string>;
}

export interface DetectionMonitorOptions {
  log?: DetectionLog;
  /** Counts consecutive turns per anti-pattern and escalates a stalled approach. */
  repetition?: RepetitionTracker;
}

export class DetectionMonitor {
  private readonly log?: DetectionLog;
  private readonly repetition?: RepetitionTracker;
  constructor(options: DetectionMonitorOptions = {}) {
    this.log = options.log;
    this.repetition = options.repetition;
  }
  private readonly alertListeners = new Set<
    (
      source: PluginHookAgent,
      turnId: string | null,
      alert: OvermindAlert,
      paseo: PaseoApi
    ) => Promise<unknown>
  >();
  private readonly captures = new Set<Promise<unknown>>();
  async drain(): Promise<void> {
    await Promise.allSettled(this.captures);
  }
  on(
    event: typeof OVERMIND_EVENT_ALERT,
    listener: (
      source: PluginHookAgent,
      turnId: string | null,
      alert: OvermindAlert,
      paseo: PaseoApi
    ) => Promise<unknown>
  ) {
    if (event !== OVERMIND_EVENT_ALERT)
      throw new Error("Unknown Overmind event");
    this.alertListeners.add(listener);
    return () => {
      this.alertListeners.delete(listener);
    };
  }
  private readonly supervisorMailbox = new MailboxMiddleware<{
    supervisorId: string;
    sourceAgentId: string;
    message: string;
    alertId: string;
    markAlert?: boolean;
  }>();
  private alerts: OvermindAlert[] = [];
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;
  private disposed = false;
  private readonly inflight = new Set<string>();
  private readonly completed = new Map<string, string>();
  private readonly liveTurns = new Map<string, LiveTurn>();
  status() {
    return {
      alerts: this.alerts,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }

  /** Alert notices still held for an agent because it was mid-turn. */
  pendingNotices(agentId: string): number {
    return this.supervisorMailbox.pending(agentId);
  }

  private shouldSkip(
    agentId: string,
    turnId: string | null,
    key: string,
    settings: OvermindSettings
  ) {
    return (
      this.disposed ||
      settings.detection.mode === "off" ||
      this.inflight.has(key) ||
      (turnId !== null && this.completed.get(agentId) === turnId)
    );
  }

  private signalKey(signal: { patterns: readonly string[] }) {
    return [...signal.patterns].sort().join(",") || "semantic";
  }

  private async appendAlert(
    alert: OvermindAlert,
    paseo: PaseoApi,
    sourceAgentId: string
  ) {
    await paseo.agents.ref(sourceAgentId).timeline.append({
      type: "plugin",
      id: `overmind-alert:${alert.id}`,
      kind: "anomaly",
      version: 1,
      data: alert,
    });
  }

  private async deliverSupervisorNotice(
    notice: {
      supervisorId: string;
      sourceAgentId: string;
      message: string;
      alertId: string;
      markAlert?: boolean;
    },
    paseo: PaseoApi,
    markAlert = true
  ): Promise<boolean> {
    const current = await paseo.agents.ref(notice.supervisorId).refresh();
    if (!current || !isAgentIdle(current.agent.status)) {
      this.supervisorMailbox.enqueue(
        notice.supervisorId,
        notice,
        current?.agent.status ?? "UNKNOWN"
      );
      return false;
    }
    await paseo.agents.ref(notice.supervisorId).send(notice.message, {
      sourceAgentId: notice.sourceAgentId,
    });
    const alert = this.alerts.find((entry) => entry.id === notice.alertId);
    if (alert && markAlert) {
      alert.supervisorNotified = true;
      alert.supervisorDelivery = {
        status: "sent",
        agentId: notice.supervisorId,
        error: null,
      };
      await this.appendAlert(alert, paseo, notice.sourceAgentId);
    }
    return true;
  }

  private async flushSupervisorMailbox(supervisorId: string, paseo: PaseoApi) {
    const notices = this.supervisorMailbox.onTurnBoundary(supervisorId);
    for (const notice of notices) {
      try {
        await this.deliverSupervisorNotice(
          notice,
          paseo,
          notice.markAlert ?? true
        );
      } catch (error) {
        const alert = this.alerts.find((entry) => entry.id === notice.alertId);
        if (alert) {
          alert.supervisorDelivery = {
            status: "failed",
            agentId: supervisorId,
            error: error instanceof Error ? error.message : String(error),
          };
          await this.appendAlert(alert, paseo, notice.sourceAgentId);
        }
      }
    }
  }

  private async findSupervisor(source: PluginHookAgent, paseo: PaseoApi) {
    const visited = new Set<string>();
    let parentId = source.parentAgentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const current = await paseo.agents.ref(parentId).refresh();
      if (!current) return null;
      if (roleForProvider(current.agent.provider) === "supervisor")
        return current.agent;
      parentId = getParentAgentId(current.agent.labels);
    }
    return null;
  }

  /**
   * A confirmed Peer signal is delivered to its Lead immediately and to the
   * ancestor Supervisor independently. Lead signals go directly to Supervisor.
   */
  async notifySupervisor(
    source: PluginHookAgent,
    alert: OvermindAlert,
    paseo: PaseoApi
  ): Promise<OvermindAlert["supervisorDelivery"]> {
    try {
      const message = [
        "[OVERMIND ANOMALY]",
        `Agent nguồn: ${source.title ?? source.id} (${source.id})`,
        `Tầng phát hiện: ${alert.tier}; điểm: ${alert.score.toFixed(2)}`,
        `Anti-pattern: ${
          alert.antiPatterns.map(antiPatternLabel).join(", ") ||
          "chưa phân loại"
        }`,
        `Tín hiệu: ${alert.patterns.join(", ") || "tương đồng ngữ nghĩa"}`,
        `Trích đoạn: ${alert.excerpt}`,
        "Hãy quan sát agent nguồn và quyết định có cần can thiệp hay không. Đây là cảnh báo, không phải lệnh dừng tự động.",
      ].join("\n");
      const parent = source.parentAgentId
        ? await paseo.agents.ref(source.parentAgentId).refresh()
        : null;
      const parentAgent = parent?.agent;
      const sourceRole = roleForProvider(source.provider);
      if (
        sourceRole === "peer" &&
        parentAgent &&
        roleForProvider(parentAgent.provider) === "lead"
      ) {
        await this.deliverSupervisorNotice(
          {
            supervisorId: parentAgent.id,
            sourceAgentId: source.id,
            message,
            alertId: alert.id,
            markAlert: false,
          },
          paseo,
          false
        );
      }
      const supervisor =
        sourceRole === "supervisor"
          ? null
          : sourceRole === "lead"
          ? parentAgent
          : await this.findSupervisor(source, paseo);
      if (
        !supervisor ||
        supervisor.archivedAt != null ||
        roleForProvider(supervisor.provider) !== "supervisor"
      )
        return {
          status: "missing",
          agentId: null,
          error:
            "Agent nguồn không có Supervisor Overmind cấp trên đang hoạt động để nhận cảnh báo.",
        };
      const sent = await this.deliverSupervisorNotice(
        {
          supervisorId: supervisor.id,
          sourceAgentId: source.id,
          message,
          alertId: alert.id,
        },
        paseo
      );
      return {
        status: sent ? "sent" : "queued",
        agentId: supervisor.id,
        error: null,
      };
    } catch (error) {
      return {
        status: "failed",
        agentId: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async recordAlert(
    source: PluginHookAgent,
    turnId: string | null,
    signal: Detection,
    objective: string,
    output: string,
    paseo: PaseoApi,
    settings: OvermindSettings
  ): Promise<OvermindAlert | null> {
    const key = `${source.id}:${turnId ?? "unknown"}:${this.signalKey(signal)}`;
    const existing = this.alerts.find((entry) => entry.id === key);
    const alert: OvermindAlert = existing ?? {
      tier: signal.tier,
      score: signal.score,
      patterns: signal.patterns,
      antiPatterns: signal.antiPatterns,
      id: key,
      agentId: source.id,
      title: source.title ?? source.id,
      timestamp: new Date().toISOString(),
      excerpt: signal.matched.slice(-500),
      jev: null,
      supervisorDelivery: { status: "queued", agentId: null, error: null },
      supervisorNotified: false,
      error: null,
    };
    alert.excerpt = signal.matched.slice(-500);
    alert.tier = signal.tier;
    alert.patterns = [...new Set([...alert.patterns, ...signal.patterns])];
    alert.antiPatterns = [
      ...new Set([...alert.antiPatterns, ...signal.antiPatterns]),
    ];
    alert.score = Math.max(alert.score, signal.score);
    if (signal.error) alert.error = signal.error;
    await annotateJev(alert, settings, objective, output);
    if (this.disposed) return null;
    for (const capture of this.alertListeners) {
      const pending = capture(source, turnId, alert, paseo);
      this.captures.add(pending);
      try {
        await pending;
      } catch (error) {
        alert.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.captures.delete(pending);
      }
    }
    if (
      !alert.supervisorNotified &&
      alert.supervisorDelivery.status === "queued"
    ) {
      const supervisor = await this.notifySupervisor(source, alert, paseo);
      alert.supervisorDelivery = supervisor;
      alert.supervisorNotified = supervisor.status === "sent";
      if (supervisor.error) alert.error = supervisor.error;
    }
    this.lastCheckedAt = new Date().toISOString();
    this.alerts = [
      alert,
      ...this.alerts.filter((entry) => entry.id !== alert.id),
    ].slice(0, 50);
    await this.appendAlert(alert, paseo, source.id);
    return alert;
  }

  /** Alert on a confirmed signal; log every candidate so rules can be reviewed later. */
  private async handleDetection(
    source: PluginHookAgent,
    turnId: string | null,
    detection: Detection,
    stage: "live" | "turn-end",
    exchange: { objective: string; output: string },
    paseo: PaseoApi,
    settings: OvermindSettings
  ) {
    const alert = detection.confirmed
      ? await this.recordAlert(
          source,
          turnId,
          detection,
          exchange.objective,
          exchange.output,
          paseo,
          settings
        )
      : null;
    await this.log
      ?.record({
        at: new Date().toISOString(),
        agentId: source.id,
        title: source.title ?? source.id,
        role: roleForProvider(source.provider),
        turnId,
        stage,
        patterns: detection.patterns,
        antiPatterns: detection.antiPatterns,
        matched: detection.matched.slice(-600),
        semanticScore: detection.semanticScore,
        threshold: settings.detection.threshold,
        confirmed: detection.confirmed,
        jev: alert?.jev?.verdict ?? null,
        error: alert?.error ?? detection.error,
      })
      .catch(() => undefined);
  }

  async onTurnStarted(
    agent: PluginHookAgent,
    turnId: string | null,
    paseo: PaseoApi,
    settings: OvermindSettings
  ) {
    if (roleForProvider(agent.provider))
      this.supervisorMailbox.setState(agent.id, "THINKING");
    if (this.disposed || settings.detection.mode === "off") return;
    // A Supervisor has no Overmind role above it to receive its alerts.
    if (
      !isOvermindAgent({}, agent.provider) ||
      roleForProvider(agent.provider) === "supervisor"
    )
      return;
    this.liveTurns.get(agent.id)?.subscription?.();
    const live: LiveTurn = {
      turnId,
      output: "",
      objective: "",
      subscription: null,
      emitted: new Set<string>(),
    };
    const subscription = paseo.agents
      .ref(agent.id)
      .timeline.subscribe((event: PaseoAgentTimelineEvent) => {
        if (event.event.type !== "timeline") return;
        const item = event.event.item;
        if (item.type === "user_message")
          live.objective = item.text.slice(-4000);
        // Tier 1 watches the live thought stream too: reasoning arrives before
        // the assistant text, and providers that publish it surface a hazard a
        // turn earlier. Tier 2 stays at the turn boundary, where one encoder
        // pass covers the whole exchange.
        if (item.type !== "assistant_message" && item.type !== "reasoning")
          return;
        live.output = `${live.output}\n${item.text}`.slice(-8000);
        if (settings.detection.mode === "semantic") return;
        const candidate = matchRules(settings, live.output);
        if (!candidate) return;
        const key = this.signalKey(candidate);
        if (live.emitted.has(key)) return;
        live.emitted.add(key);
        const exchange = { objective: live.objective, output: live.output };
        void this.detectLive(agent, turnId, exchange, paseo, settings).catch(
          (error: unknown) => {
            this.lastError =
              error instanceof Error ? error.message : String(error);
          }
        );
      });
    live.subscription = subscription;
    this.liveTurns.set(agent.id, live);
  }

  private async detectLive(
    agent: PluginHookAgent,
    turnId: string | null,
    exchange: { objective: string; output: string },
    paseo: PaseoApi,
    settings: OvermindSettings
  ) {
    await configureEmbeddingRuntime(paseo);
    const detection = await detectOutput(
      settings,
      exchange.output,
      fetch,
      "live"
    );
    if (detection)
      await this.handleDetection(
        agent,
        turnId,
        detection,
        "live",
        exchange,
        paseo,
        settings
      );
  }

  async onTurnEnded(
    agent: PluginHookAgent,
    turnId: string | null,
    outcome: PluginTurnOutcome,
    paseo: PaseoApi,
    settings: OvermindSettings
  ) {
    if (roleForProvider(agent.provider))
      await this.flushSupervisorMailbox(agent.id, paseo);
    if (roleForProvider(agent.provider) === "supervisor") return;
    const inflightKey = `${agent.id}:${turnId ?? "unknown"}`;
    if (this.shouldSkip(agent.id, turnId, inflightKey, settings)) return;
    this.inflight.add(inflightKey);
    try {
      const live = this.liveTurns.get(agent.id);
      live?.subscription?.();
      this.liveTurns.delete(agent.id);
      const ref = paseo.agents.ref(agent.id);
      const current = await ref.refresh();
      if (!current || !isOvermindAgent(current.agent.labels, agent.provider))
        return;
      if (outcome.kind === "canceled") return;
      const page = await ref.timeline.refetch({ direction: "tail", limit: 30 });
      const exchange = latestExchange(page.entries.map((entry) => entry.item));
      const output =
        outcome.kind === "failed"
          ? `${exchange.output}\n${outcome.error.message}`.slice(-8000)
          : exchange.output;
      await configureEmbeddingRuntime(paseo);
      const signals = (
        outcome.kind === "failed"
          ? [
              {
                tier: "regex",
                score: 1,
                patterns: ["turn-failed"],
                antiPatterns: ["loss-of-momentum"],
                matched: outcome.error.message,
                semanticScore: null,
                confirmed: true,
                error: null,
              } satisfies Detection,
            ]
          : [
              await detectOutput(settings, output),
              detectUnverifiedClaim(settings, exchange),
            ]
      ).filter((signal): signal is Detection => signal !== null);
      if (this.disposed) return;
      this.lastCheckedAt = new Date().toISOString();
      this.lastError = null;
      if (turnId) this.completed.set(agent.id, turnId);
      for (const signal of signals)
        await this.handleDetection(
          agent,
          turnId,
          signal,
          "turn-end",
          { objective: exchange.objective, output },
          paseo,
          settings
        );
      await this.assessRepetition(agent, turnId, signals, paseo, settings);
    } catch (error) {
      if (!this.disposed)
        this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.inflight.delete(inflightKey);
    }
  }
  /** Every assessed turn counts; the same anti-pattern REPEAT_LIMIT turns running escalates. */
  private async assessRepetition(
    agent: PluginHookAgent,
    turnId: string | null,
    signals: readonly Detection[],
    paseo: PaseoApi,
    settings: OvermindSettings
  ) {
    if (!this.repetition || !roleForProvider(agent.provider)) return;
    const found = new Map<string, string>();
    for (const signal of signals)
      if (signal.confirmed)
        for (const antiPattern of signal.antiPatterns)
          if (antiPattern !== CUSTOM_SIGNAL)
            found.set(antiPattern, signal.matched);
    const escalations = await this.repetition.observe(agent.id, turnId, found);
    for (const escalation of escalations)
      await this.escalate(agent, escalation, paseo, settings);
  }

  /**
   * The owning role must choose a different approach. Its Overmind tools refuse further
   * prompts to the stalled agent until it states the new approach; a Peer's stall is
   * also reported to the Supervisor.
   */
  private async escalate(
    agent: PluginHookAgent,
    escalation: Escalation,
    paseo: PaseoApi,
    settings: OvermindSettings
  ) {
    const label = antiPatternLabel(escalation.antiPattern);
    const evidence = escalation.evidence
      .map(
        (entry, index) =>
          `${index + 1}. lượt ${entry.turnId ?? "?"}: ${entry.excerpt}`
      )
      .join("\n");
    const parent = agent.parentAgentId
      ? (await paseo.agents.ref(agent.parentAgentId).refresh())?.agent
      : null;
    const recipients: { id: string; message: string }[] = [];
    if (parent && !parent.archivedAt && roleForProvider(parent.provider))
      recipients.push({
        id: parent.id,
        message: [
          "[OVERMIND REPETITION · ĐỔI HƯỚNG BẮT BUỘC]",
          `${agent.title ?? agent.id} (${agent.id}) gặp "${label}" ${
            escalation.count
          } lượt liên tiếp mà không tiến triển.`,
          `Bằng chứng:\n${evidence}`,
          "Không giao lại cùng cách làm. Chọn hướng khác: đặt lại khung bài toán, đổi cách tiếp cận, chia nhỏ việc, giao cho agent khác, hoặc hỏi Human.",
          "Gửi hướng mới bằng send_agent_prompt kèm trường newApproach. Overmind từ chối mọi lệnh tiếp theo tới agent này cho đến khi có newApproach.",
        ].join("\n"),
      });
    const supervisorId =
      parent && roleForProvider(parent.provider) === "lead"
        ? getParentAgentId(parent.labels) ?? null
        : null;
    if (supervisorId)
      recipients.push({
        id: supervisorId,
        message: [
          "[OVERMIND REPETITION · THEO DÕI]",
          `Peer ${agent.title ?? agent.id} (${agent.id}) dưới Lead ${
            parent!.title ?? parent!.id
          } gặp "${label}" ${
            escalation.count
          } lượt liên tiếp. Lead đã được yêu cầu đổi hướng.`,
          `Bằng chứng:\n${evidence}`,
        ].join("\n"),
      });
    for (const recipient of recipients)
      await this.deliverSupervisorNotice(
        {
          supervisorId: recipient.id,
          sourceAgentId: agent.id,
          message: recipient.message,
          alertId: `repeat:${agent.id}:${escalation.antiPattern}`,
        },
        paseo
      ).catch(() => false);
    await this.log
      ?.record({
        at: new Date().toISOString(),
        agentId: agent.id,
        title: agent.title ?? agent.id,
        role: roleForProvider(agent.provider),
        turnId: escalation.evidence.at(-1)?.turnId ?? null,
        stage: "escalation",
        patterns: [`repeat-${REPEAT_LIMIT}`],
        antiPatterns: [escalation.antiPattern],
        matched: evidence.slice(-600),
        semanticScore: null,
        threshold: settings.detection.threshold,
        confirmed: true,
        jev: null,
        error: recipients.length
          ? null
          : "Không có role cấp trên đang hoạt động để nhận leo thang",
      })
      .catch(() => undefined);
  }

  close(agentId: string) {
    this.liveTurns.get(agentId)?.subscription?.();
    this.liveTurns.delete(agentId);
    this.completed.delete(agentId);
    this.supervisorMailbox.clear(agentId);
  }
  dispose() {
    this.disposed = true;
    for (const live of this.liveTurns.values()) live.subscription?.();
    this.liveTurns.clear();
    this.supervisorMailbox.clearAll();
    this.completed.clear();
    this.alerts = [];
    this.alertListeners.clear();
  }
}
