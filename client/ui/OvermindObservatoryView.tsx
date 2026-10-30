/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- React Native theme styles and node callbacks are composed at render time. */

import type { PluginScreenProps, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  controlStatus,
  projectHistory,
  reviewTask,
  seatLabels,
  type OvermindAlert,
} from "../../shared/control.js";
import {
  TASK_STATUSES,
  taskStatus,
  reviewableTurn,
  type TaskStatus,
  type TaskAgentState,
} from "../../shared/tasks.js";
import { roleForProvider } from "../../shared/providers.js";
import { buildAgentForest, isOvermindAgent, type AgentBranchNode } from "../agent-graph.js";
import { AgentConsole } from "./AgentConsole.js";

type AgentRole = "SUPERVISOR" | "LEAD" | "PEER";
type AgentStatus = "IDLE" | "THINKING" | "EXECUTING" | "MAILBOX_HOLDING";

interface AgentNode {
  id: string;
  name: string;
  role: AgentRole;
  driver: string;
  model: string;
  status: AgentStatus;
  contextUsage: number | null;
  tokenCount: string;
  mailboxCount: number;
  workspaceId: string | null;
  labels: Readonly<Record<string, string>>;
  taskState: TaskAgentState;
}

interface TaskItem {
  id: string;
  title: string;
  scope: string;
  assignedAgent: string;
  status: TaskStatus;
  agentId: string;
  turnId: string | null;
  reviewEvidence?: string;
  reviewerKind?: string;
  requestedChange?: string;
  reopened: boolean;
  /** Read back from the project's task history after its agent was archived. */
  archivedIn?: string;
}

interface SensorEvent {
  id: string;
  timestamp: string;
  tier: "TIER_1_REGEX" | "TIER_2_ENCODER" | "EVENT_BUS";
  similarityScore: number | null;
  triggerKey: string;
  targetAgent: string;
  actionTaken: string;
}

function roleFromLabels(labels: Readonly<Record<string, string>>): AgentRole {
  const role = labels["overmind.role"]?.toUpperCase();
  return role === "SUPERVISOR" || role === "LEAD" || role === "PEER" ? role : "PEER";
}

function statusFromAgent(status: string, labels: Readonly<Record<string, string>>): AgentStatus {
  const explicit = labels["overmind.status"]?.toUpperCase();
  if (
    explicit === "IDLE" ||
    explicit === "THINKING" ||
    explicit === "EXECUTING" ||
    explicit === "MAILBOX_HOLDING"
  )
    return explicit;
  if (status === "running") return "EXECUTING";
  return "IDLE";
}

/** A seat whose own work is still out: a running descendant, a question to its Supervisor, a dual-seat. */
function isAwaiting(agent: AgentNode, agents: readonly AgentNode[]): boolean {
  if (agent.labels["overmind.ask.pending"] || agent.labels["overmind.dual_seat.status"])
    return true;
  return agents.some(
    (child) =>
      child.labels["paseo.parent-agent-id"] === agent.id &&
      (child.taskState.status === "running" ||
        Boolean(child.taskState.activeTurn) ||
        isAwaiting(child, agents)),
  );
}

/** What the console says the seat is doing now and what may need the owner. */
function seatActivity(agent: AgentNode, agents: readonly AgentNode[]): string[] {
  const { labels } = agent;
  const task = agent.name.split(" - ").slice(2).join(" - ");
  const lines = [`Việc: ${task || agent.name}`];
  if (labels["overmind.repeat.escalated"])
    lines.push(`Lặp anti-pattern ${labels["overmind.repeat.escalated"]}: cần đổi hướng.`);
  if (labels["overmind.intent.open"])
    lines.push(`Đang chờ Đại ca trả lời ${labels["overmind.intent.open"]} câu hỏi.`);
  if (labels["overmind.ask.pending"]) lines.push("Đang chờ Supervisor trả lời câu hỏi.");
  if (labels["overmind.dual_seat.status"])
    lines.push(`Đang chờ dual-seat: ${labels["overmind.dual_seat.status"]} hướng đã báo.`);
  const working = agents.filter(
    (child) => child.labels["paseo.parent-agent-id"] === agent.id && child.status !== "IDLE",
  );
  if (working.length)
    lines.push(
      `Đang chờ ${working.map((child) => child.name.split(" - ")[0]).join(", ")} báo cáo.`,
    );
  if (agent.mailboxCount > 0) lines.push(`${agent.mailboxCount} thông báo chờ trong mailbox.`);
  if (agent.status !== "IDLE") lines.push("Đang chạy lượt.");
  else if (lines.length === 1) {
    const outcome = labels["overmind.turn.outcome"];
    lines.push(outcome ? `Idle · lượt cuối: ${outcome}.` : "Idle.");
  }
  return lines;
}

/**
 * One card per Lead or Peer, placed by its latest turn. The Supervisor answers the Human
 * directly, so it shows only while it works and never waits for review.
 */
function matrixTasks(agents: readonly AgentNode[]): TaskItem[] {
  return agents.flatMap((agent) => {
    const task = taskFromAgent(agent, isAwaiting(agent, agents));
    return agent.role === "SUPERVISOR" && task.status !== "IN_PROGRESS" ? [] : [task];
  });
}

function taskFromAgent(agent: AgentNode, awaiting: boolean): TaskItem {
  const { labels } = agent;
  const state = { ...agent.taskState, labels, awaiting };
  return {
    id: labels["overmind.task.id"] ?? agent.id,
    title: labels["overmind.task.title"] ?? agent.name,
    scope: labels["overmind.task.scope"] ?? `${agent.role} · ${agent.model}`,
    assignedAgent: agent.name,
    status: taskStatus(state),
    agentId: agent.id,
    turnId: reviewableTurn(state),
    reviewEvidence: labels["overmind.review.evidence"],
    reviewerKind: labels["overmind.review.reviewer_kind"],
    requestedChange: labels["overmind.review.requested_change"],
    reopened:
      labels["overmind.review.decision"] === "reopened" &&
      (labels["overmind.review.message_at"] ?? "") === (state.lastUserMessageAt ?? "") &&
      labels["overmind.review.turn_id"] === reviewableTurn(state),
  };
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) return "Usage unavailable";
  if (value < 1000) return `${value} tokens`;
  return `${Math.round(value / 1000)}k tokens`;
}

interface AgentPayload {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  status: string;
  workspaceId?: string | null;
  labels: Readonly<Record<string, string>>;
  activeTurn?: unknown;
  lastUserMessageAt?: string | null;
  lastUsage?: {
    contextWindowMaxTokens?: number;
    contextWindowUsedTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}
type SeatOverlays = Readonly<Record<string, Readonly<Record<string, string>>>>;
const SEAT_REFRESH_MS = 4000;

function toAgentNode(entry: { agent: AgentPayload }): AgentNode {
  const { agent } = entry;
  const used = agent.lastUsage?.contextWindowUsedTokens;
  const max = agent.lastUsage?.contextWindowMaxTokens;
  const contextUsage =
    used !== undefined && max ? Math.min(100, Math.round((used / max) * 100)) : null;
  const mailboxCount = Number(agent.labels["overmind.mailbox_count"] ?? 0);
  return {
    id: agent.id,
    name: agent.title ?? agent.id,
    role: roleFromLabels({
      ...agent.labels,
      ...(roleForProvider(agent.provider)
        ? { "overmind.role": roleForProvider(agent.provider)! }
        : {}),
    }),
    driver: agent.provider,
    model: agent.model ?? agent.provider,
    status: statusFromAgent(agent.status, agent.labels),
    contextUsage,
    tokenCount:
      used !== undefined && max
        ? `${formatTokens(used)} / ${formatTokens(max)}`
        : `${formatTokens(agent.lastUsage?.inputTokens)} + ${formatTokens(agent.lastUsage?.outputTokens)}`,
    mailboxCount: Number.isFinite(mailboxCount) ? mailboxCount : 0,
    workspaceId: agent.workspaceId ?? null,
    labels: agent.labels,
    taskState: {
      status: agent.status,
      activeTurn: agent.activeTurn,
      lastUserMessageAt: agent.lastUserMessageAt,
      labels: agent.labels,
    },
  };
}

function withoutAgent(agents: readonly AgentPayload[], agentId: string): AgentPayload[] {
  return agents.filter((agent) => agent.id !== agentId);
}

function withAgent(agents: readonly AgentPayload[], updated: AgentPayload): AgentPayload[] {
  return [...withoutAgent(agents, updated.id), updated];
}

function timeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? timestamp : date.toLocaleTimeString();
}

function roleColor(role: AgentRole, theme: PluginScreenProps["theme"]): string {
  if (role === "SUPERVISOR") return "#a78bfa";
  if (role === "LEAD") return "#38bdf8";
  return theme.colors.foregroundMuted;
}

function statusColor(status: AgentStatus, theme: PluginScreenProps["theme"]): string {
  if (status === "EXECUTING") return theme.colors.statusSuccess;
  if (status === "THINKING") return theme.colors.accent;
  if (status === "MAILBOX_HOLDING") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

function Chip({ children, color }: { children: string; color: string }) {
  return (
    <View style={[styles.chip, { borderColor: `${color}55`, backgroundColor: `${color}18` }]}>
      <Text style={[styles.monoSmall, { color }]}>{children}</Text>
    </View>
  );
}

function SectionTitle({
  icon,
  title,
  theme,
}: {
  icon: string;
  title: string;
  theme: PluginScreenProps["theme"];
}) {
  return (
    <View style={styles.sectionTitle}>
      <Icon name={icon} size={15} color={theme.colors.accent} />
      <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>{title}</Text>
    </View>
  );
}

function AgentNodeView({
  agent,
  theme,
  selected,
  onPress,
}: {
  agent: AgentNode;
  theme: PluginScreenProps["theme"];
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${agent.role.toLowerCase()} agent ${agent.name}`}
      onPress={onPress}
      style={[
        styles.nodeCard,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: selected ? theme.colors.accent : theme.colors.border,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      <View style={styles.rowBetween}>
        <Chip color={roleColor(agent.role, theme)}>{agent.role}</Chip>
        <Chip color={statusColor(agent.status, theme)}>{agent.status}</Chip>
      </View>
      <Text style={[styles.nodeName, { color: theme.colors.foreground }]} numberOfLines={2}>
        {agent.name}
      </Text>
      {agent.labels["overmind.repeat.escalated"] ? (
        <Chip color={theme.colors.statusDanger}>
          {`LẶP · ${agent.labels["overmind.repeat.escalated"]}`}
        </Chip>
      ) : null}
      {agent.labels["overmind.dual_seat.status"] ? (
        <Chip color="#a78bfa">{`DUAL · chờ ${agent.labels["overmind.dual_seat.status"]}`}</Chip>
      ) : null}
      {agent.labels["overmind.intent.open"] ? (
        <Chip color={theme.colors.statusWarning}>
          {`HỎI ĐẠI CA · ${agent.labels["overmind.intent.open"]}`}
        </Chip>
      ) : null}
      {agent.labels["overmind.ask.pending"] ? (
        <Chip color={theme.colors.statusWarning}>HỎI SUP</Chip>
      ) : null}
      {agent.labels["overmind.dual_seat.side"] ? (
        <Chip color="#a78bfa">{`DUAL · Hướng ${agent.labels["overmind.dual_seat.side"]}`}</Chip>
      ) : null}
      <View style={styles.metricRow}>
        <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
          Context usage
        </Text>
        <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
          {agent.contextUsage === null ? "—" : `${agent.contextUsage}%`}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: theme.colors.surface2 }]}>
        <View
          style={[
            styles.fill,
            {
              width: `${agent.contextUsage ?? 0}%`,
              backgroundColor: theme.colors.accent,
            },
          ]}
        />
      </View>
      {agent.mailboxCount > 0 ? (
        <View style={[styles.mailbox, { borderTopColor: theme.colors.border }]}>
          <Icon name="Inbox" size={13} color={theme.colors.statusWarning} />
          <Text style={[styles.monoSmall, { color: theme.colors.statusWarning }]}>
            {agent.mailboxCount} held in mailbox
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function TaskCard({
  task,
  theme,
  onReviewed,
}: {
  task: TaskItem;
  theme: PluginScreenProps["theme"];
  onReviewed(result: RpcOutput<typeof reviewTask>): void;
}) {
  const review = useRpc(reviewTask);
  const [evidence, setEvidence] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(decision: "accepted" | "reopened") {
    if (!task.turnId || pending) return;
    if (!evidence.trim()) {
      setError("Nhập bằng chứng nghiệm thu hoặc lý do mở lại.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      onReviewed(await review({ agentId: task.agentId, turnId: task.turnId, decision, evidence }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <View
      style={[
        styles.taskCard,
        { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
      ]}
    >
      <Text style={[styles.taskTitle, { color: theme.colors.foreground }]} numberOfLines={2}>
        {task.title}
      </Text>
      <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]} numberOfLines={1}>
        {task.scope}
      </Text>
      <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]} numberOfLines={1}>
        {task.assignedAgent}
      </Text>
      {task.archivedIn ? (
        <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]} numberOfLines={1}>
          Đã archive · {task.archivedIn}
        </Text>
      ) : null}
      {task.status === "DONE" ? (
        <Text style={[styles.taskMeta, { color: theme.colors.statusSuccess }]} numberOfLines={3}>
          Đã nghiệm thu · {task.reviewEvidence}
        </Text>
      ) : null}
      {task.reopened ? (
        <Text style={[styles.taskMeta, { color: theme.colors.statusWarning }]} numberOfLines={3}>
          Đã mở lại · {task.reviewEvidence}
        </Text>
      ) : null}
      {task.reviewerKind &&
      (task.status === "DONE" || task.reopened || task.status === "WAITING_FOR_HUMAN") ? (
        <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
          Người đánh giá: {task.reviewerKind === "supervisor" ? "Supervisor" : "Human"}
        </Text>
      ) : null}
      {task.status === "WAITING_FOR_HUMAN" ? (
        <Text style={[styles.taskMeta, { color: theme.colors.statusWarning }]} numberOfLines={5}>
          Chờ human quyết định thay đổi ngoài phạm vi đã thống nhất: {task.requestedChange}
          {"\n"}Lý do: {task.reviewEvidence}
        </Text>
      ) : null}
      {task.status === "READY_FOR_REVIEW" && !task.turnId && !task.archivedIn ? (
        <Text style={[styles.taskMeta, { color: theme.colors.foregroundMuted }]}>
          Chưa có định danh lượt để nghiệm thu. Chạy lại task trên host đã cập nhật.
        </Text>
      ) : null}
      {task.turnId ? (
        <View style={{ gap: 8 }}>
          <TextInput
            accessibilityLabel={`Review evidence for ${task.title}`}
            value={evidence}
            onChangeText={setEvidence}
            multiline
            editable={!pending}
            placeholder="Bằng chứng kiểm tra / lý do mở lại"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[
              styles.reviewInput,
              { color: theme.colors.foreground, borderColor: theme.colors.border },
            ]}
          />
          <View style={styles.wrapRow}>
            {task.status !== "DONE" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Accept task ${task.title}`}
                disabled={pending}
                onPress={() => void submit("accepted")}
                style={[styles.reviewButton, { backgroundColor: theme.colors.accent }]}
              >
                <Text style={[styles.reviewButtonText, { color: theme.colors.foreground }]}>
                  {pending ? "Đang lưu…" : "Nghiệm thu"}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Reopen task ${task.title}`}
              disabled={pending}
              onPress={() => void submit("reopened")}
              style={[styles.reviewButton, { borderWidth: 1, borderColor: theme.colors.border }]}
            >
              <Text style={[styles.reviewButtonText, { color: theme.colors.foreground }]}>
                Mở lại
              </Text>
            </Pressable>
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function EmptyState({ text, theme }: { text: string; theme: PluginScreenProps["theme"] }) {
  return (
    <View style={[styles.empty, { borderColor: theme.colors.border }]}>
      <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>{text}</Text>
    </View>
  );
}

export function OvermindCommandView({
  theme,
  layout,
  host,
  navigation,
  onOpenSettings,
}: PluginScreenProps & { onOpenSettings?: () => void }) {
  const paseo = usePaseo();
  const readSeats = useRpc(seatLabels);
  const [rawAgents, setRawAgents] = useState<AgentPayload[]>([]);
  const [overlays, setOverlays] = useState<SeatOverlays>({});
  // Overmind task state lives in the plugin; lay it over each agent's own labels.
  const agents = useMemo(
    () =>
      rawAgents.map((agent) =>
        toAgentNode({ agent: { ...agent, labels: { ...agent.labels, ...overlays[agent.id] } } }),
      ),
    [rawAgents, overlays],
  );
  const agentIdsKey = rawAgents.map((agent) => agent.id).join(",");
  const readSeatsRef = useRef(readSeats);
  readSeatsRef.current = readSeats;
  const [loaded, setLoaded] = useState(false);
  const [sensorLogs, setSensorLogs] = useState<SensorEvent[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const readHistory = useRpc(projectHistory);
  const readHistoryRef = useRef(readHistory);
  readHistoryRef.current = readHistory;
  const [history, setHistory] = useState<RpcOutput<typeof projectHistory> | null>(null);
  // An archive removes the agent from the live list, so re-read the projects when it changes.
  useEffect(() => {
    let disposed = false;
    readHistoryRef
      .current({})
      .then((result) => {
        if (!disposed) setHistory(result);
        return undefined;
      })
      .catch((error: unknown) => {
        if (!disposed)
          setHistory({
            projects: [],
            errors: [error instanceof Error ? error.message : String(error)],
          });
      });
    return () => {
      disposed = true;
    };
  }, [agentIdsKey]);
  const tasks = useMemo(() => {
    const live = new Set(agents.map((agent) => agent.id));
    const archived = (history?.projects ?? [])
      .flatMap((project) => project.tasks.map((record) => ({ record, project: project.name })))
      .filter(({ record }) => !live.has(record.agentId))
      .sort((left, right) => right.record.updatedAt.localeCompare(left.record.updatedAt))
      .map(({ record, project }) =>
        Object.assign(
          taskFromAgent(toAgentNode({ agent: { ...record, id: record.agentId } }), false),
          {
            turnId: null,
            archivedIn: project,
          },
        ),
      );
    return [...matrixTasks(agents), ...archived];
  }, [agents, history]);
  const forest = useMemo(() => buildAgentForest(agents, host.id), [agents, host.id]);

  useEffect(() => {
    const lifetime = new AbortController();
    let disposed = false;
    let stopAgentUpdates: (() => void) | undefined;
    let releaseAgents: (() => Promise<void>) | undefined;
    let liveAgents: AgentPayload[] = [];

    const applyEntries = (entries: readonly { agent: AgentPayload }[]) => {
      liveAgents = entries
        .filter((entry) => isOvermindAgent(entry.agent.labels, entry.agent.provider))
        .map((entry) => entry.agent);
      setRawAgents(liveAgents);
      setLoaded(true);
      setConnectionError(null);
    };
    const applyAgentUpdate = (transform: (current: AgentPayload[]) => AgentPayload[]) => {
      liveAgents = transform(liveAgents);
      setRawAgents(liveAgents);
    };

    void paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then((result) => {
        if (disposed) {
          void result.subscription?.release();
          return undefined;
        }
        applyEntries(result.entries);
        if (!result.subscription) return undefined;
        releaseAgents = result.subscription.release.bind(result.subscription);
        stopAgentUpdates = result.subscription.subscribe({
          snapshot: (snapshot) => applyEntries(snapshot.entries),
          update: (message) => {
            if (message.type !== "agent_update") return;
            const payload = message.payload;
            if (payload.kind === "remove") {
              const removedId = payload.agentId;
              applyAgentUpdate((current) => withoutAgent(current, removedId));
              return;
            }
            if (!isOvermindAgent(payload.agent.labels, payload.agent.provider)) {
              applyAgentUpdate((current) => withoutAgent(current, payload.agent.id));
              return;
            }
            const updated = payload.agent;
            applyAgentUpdate((current) => withAgent(current, updated));
          },
        });
        return undefined;
      })
      .catch((error: unknown) => {
        if (!disposed && !lifetime.signal.aborted)
          setConnectionError(error instanceof Error ? error.message : String(error));
      });

    const eventStream = paseo.observeEvents(["agent_attention_required"], {
      signal: lifetime.signal,
      notifications: false,
    });
    const stopEvents = eventStream.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type !== "agent_attention_required") return;
        const payload = message.payload;
        if (!liveAgents.some((agent) => agent.id === payload.agentId)) return;
        const event: SensorEvent = {
          id: `${payload.agentId}-${payload.timestamp}`,
          timestamp: timeLabel(payload.timestamp),
          tier: "EVENT_BUS",
          similarityScore: null,
          triggerKey: payload.reason,
          targetAgent: payload.agentId,
          actionTaken: payload.shouldNotify
            ? "Attention notification emitted"
            : "Attention recorded",
        };
        setSensorLogs((current) => [event, ...current].slice(0, 40));
      },
    });

    return () => {
      disposed = true;
      lifetime.abort();
      stopAgentUpdates?.();
      stopEvents();
      void releaseAgents?.();
      void eventStream.release();
    };
  }, [paseo]);

  useEffect(() => {
    const ids = agentIdsKey ? agentIdsKey.split(",") : [];
    if (!ids.length) return undefined;
    let disposed = false;
    const refresh = () =>
      readSeatsRef
        .current({ agentIds: ids })
        .then((result) => {
          if (!disposed) setOverlays(result.seats);
          return undefined;
        })
        .catch(() => undefined);
    void refresh();
    // Seat state changes at turn boundaries the agent stream already reports; poll to catch
    // writes that land just after the update.
    const timer = setInterval(refresh, SEAT_REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [agentIdsKey, rawAgents]);

  const groupedTasks = useMemo(
    () =>
      Object.fromEntries(
        TASK_STATUSES.map((status) => [status, tasks.filter((task) => task.status === status)]),
      ) as Record<TaskStatus, TaskItem[]>,
    [tasks],
  );

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  // Open on a working seat, then stay on it so the console does not jump between agents.
  const fallbackId = (agents.find((agent) => agent.status !== "IDLE") ?? agents[0])?.id ?? null;
  useEffect(() => {
    if (!selectedAgent && fallbackId) setSelectedAgentId(fallbackId);
  }, [selectedAgent, fallbackId]);

  function selectAgent(agent: AgentNode) {
    setSelectedAgentId(agent.id);
  }
  function applyReview(result: RpcOutput<typeof reviewTask>) {
    setOverlays((current) => ({
      ...current,
      [result.agentId]: { ...current[result.agentId], ...result.labels },
    }));
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 24, paddingBottom: 40 }}
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <View style={styles.headerTitle}>
          <View
            style={[
              styles.logo,
              {
                backgroundColor: `${theme.colors.accent}18`,
                borderColor: `${theme.colors.accent}55`,
              },
            ]}
          >
            <Icon name="BrainCircuit" size={25} color={theme.colors.accent} />
          </View>
          <View style={styles.flex}>
            <View style={styles.titleLine}>
              <Text style={[styles.title, { color: theme.colors.foreground }]}>
                Overmind Command
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Settings"
                onPress={onOpenSettings}
                style={[styles.openAgentButton, { borderColor: theme.colors.border, marginTop: 0 }]}
              >
                <Text style={{ color: theme.colors.foreground }}>Settings</Text>
              </Pressable>
            </View>
            <Text style={[styles.subtitle, { color: theme.colors.foregroundMuted }]}>
              S-L-P command surface for Overmind agents
            </Text>
          </View>
        </View>
        <View style={styles.connection}>
          <View
            style={[
              styles.dot,
              {
                backgroundColor: connectionError
                  ? theme.colors.statusDanger
                  : theme.colors.statusSuccess,
              },
            ]}
          />
          <Text
            style={[
              styles.monoSmall,
              { color: connectionError ? theme.colors.statusDanger : theme.colors.statusSuccess },
            ]}
          >
            {connectionError ? "EventBus error" : "EventBus connected"}
          </Text>
        </View>
      </View>

      <View>
        <SectionTitle icon="Workflow" title="OVERMIND S-L-P DIAGRAM" theme={theme} />
        {agents.length ? (
          <View style={[styles.split, layout.compact ? { flexDirection: "column" } : null]}>
            <View
              style={[
                styles.diagram,
                layout.compact ? null : styles.diagramColumn,
                { borderColor: theme.colors.border },
              ]}
            >
              <Text style={[styles.diagramHint, { color: theme.colors.foregroundMuted }]}>
                Agent Overmind theo quan hệ cha/con. Bấm thẻ để xem chat và can thiệp.
              </Text>
              <ScrollView
                nestedScrollEnabled
                style={styles.diagramBody}
                contentContainerStyle={styles.scrollBody}
              >
                {forest.map((node) => (
                  <AgentBranch
                    key={node.agent.id}
                    node={node}
                    theme={theme}
                    selectedAgentId={selectedAgent?.id ?? null}
                    onSelect={selectAgent}
                  />
                ))}
              </ScrollView>
            </View>
            {selectedAgent ? (
              <AgentConsole
                key={selectedAgent.id}
                agent={selectedAgent}
                doing={seatActivity(selectedAgent, agents)}
                theme={theme}
                onOpenAgent={
                  navigation ? () => navigation.openAgent({ agentId: selectedAgent.id }) : undefined
                }
              />
            ) : null}
          </View>
        ) : (
          <EmptyState
            text={
              connectionError ??
              (loaded
                ? "Chưa có agent Overmind. Mở Settings để cấu hình, rồi chọn Overmind Supervisor, Lead hoặc Peer khi tạo agent."
                : "Đang tải agent Overmind…")
            }
            theme={theme}
          />
        )}
      </View>

      <View>
        <SectionTitle icon="Layers" title="DYNAMIC TASK MATRIX" theme={theme} />
        <View style={styles.taskGrid}>
          {TASK_STATUSES.filter((status) => !layout.compact || groupedTasks[status].length > 0).map(
            (status) => (
              <View
                key={status}
                style={[
                  styles.column,
                  {
                    backgroundColor: `${theme.colors.surface1}99`,
                    borderColor: theme.colors.border,
                  },
                ]}
              >
                <View style={[styles.columnHeader, { borderBottomColor: theme.colors.border }]}>
                  <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
                    {status.replaceAll("_", " ")}
                  </Text>
                  <Chip color={theme.colors.foregroundMuted}>
                    {String(groupedTasks[status].length)}
                  </Chip>
                </View>
                {groupedTasks[status].length ? (
                  <ScrollView
                    nestedScrollEnabled
                    style={styles.columnBody}
                    contentContainerStyle={styles.scrollBody}
                  >
                    {groupedTasks[status].map((task) => (
                      <TaskCard key={task.id} task={task} theme={theme} onReviewed={applyReview} />
                    ))}
                  </ScrollView>
                ) : (
                  <EmptyState text="Không có seat ở trạng thái này" theme={theme} />
                )}
              </View>
            ),
          )}
        </View>
      </View>

      <DetectionPanel
        theme={theme}
        onOpenAgent={(agentId) => {
          setSelectedAgentId(agentId);
          navigation?.openAgent({ agentId });
        }}
      />

      <NotebookPanel theme={theme} history={history} />

      <View>
        <SectionTitle icon="Terminal" title="REAL-TIME EVENT STREAM" theme={theme} />
        {sensorLogs.length ? (
          sensorLogs.map((log) => (
            <View
              key={log.id}
              style={[
                styles.logRow,
                { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
              ]}
            >
              <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
                {log.timestamp}
              </Text>
              <Chip
                color={log.tier === "EVENT_BUS" ? theme.colors.statusWarning : theme.colors.accent}
              >
                {log.tier}
              </Chip>
              <Text style={[styles.logText, { color: theme.colors.foreground }]} numberOfLines={1}>
                {log.triggerKey} · {log.targetAgent}
              </Text>
              <Text style={[styles.monoSmall, { color: theme.colors.statusSuccess }]}>
                {log.actionTaken}
              </Text>
            </View>
          ))
        ) : (
          <EmptyState text="No attention events received yet" theme={theme} />
        )}
      </View>
    </ScrollView>
  );
}

function AgentBranch({
  node,
  theme,
  selectedAgentId,
  onSelect,
}: {
  node: AgentBranchNode<AgentNode>;
  theme: PluginScreenProps["theme"];
  selectedAgentId: string | null;
  onSelect(agent: AgentNode): void;
}) {
  return (
    <View style={{ gap: 0, alignItems: "stretch", width: "100%" }}>
      <AgentNodeView
        agent={node.agent}
        theme={theme}
        selected={node.agent.id === selectedAgentId}
        onPress={() => onSelect(node.agent)}
      />
      {node.children.length ? (
        <View
          style={{
            marginLeft: 10,
            paddingLeft: 12,
            borderLeftWidth: 1,
            borderLeftColor: theme.colors.border,
            gap: 8,
            paddingTop: 8,
          }}
        >
          {node.children.map((child) => (
            <View key={child.agent.id}>
              <View
                style={{
                  position: "absolute",
                  left: -12,
                  top: 18,
                  width: 12,
                  height: 1,
                  backgroundColor: theme.colors.border,
                }}
              />
              <AgentBranch
                node={child}
                theme={theme}
                selectedAgentId={selectedAgentId}
                onSelect={onSelect}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Owner-side notebook review: every project's Supervisor causal entries, archived seats included. */
function NotebookPanel({
  theme,
  history,
}: {
  theme: PluginScreenProps["theme"];
  history: RpcOutput<typeof projectHistory> | null;
}) {
  const entries = useMemo(
    () =>
      (history?.projects ?? [])
        .flatMap((project) =>
          project.notebook.map((entry) => ({ ...entry, project: project.name })),
        )
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp)),
    [history],
  );
  const error = history?.errors[0] ?? null;

  return (
    <View style={{ gap: 8 }}>
      <SectionTitle icon="NotebookPen" title="CAUSAL NOTEBOOK" theme={theme} />
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
      {entries.length ? (
        <ScrollView
          nestedScrollEnabled
          style={styles.notebookBody}
          contentContainerStyle={styles.scrollBody}
        >
          {entries.map((entry) => (
            <View
              key={entry.id}
              style={[
                styles.taskCard,
                { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
              ]}
            >
              <View style={styles.wrapRow}>
                <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
                  {timeLabel(entry.timestamp)}
                </Text>
                <Chip color={theme.colors.foregroundMuted}>{entry.project}</Chip>
                {entry.antiPattern ? (
                  <Chip color={theme.colors.statusWarning}>{entry.antiPattern}</Chip>
                ) : null}
                {entry.protocolCandidate ? (
                  <Chip color={theme.colors.accent}>Protocol candidate</Chip>
                ) : null}
                <Chip
                  color={theme.colors.foregroundMuted}
                >{`${entry.evidenceCount} evidence`}</Chip>
              </View>
              <Text style={[styles.taskTitle, { color: theme.colors.foreground }]}>
                {entry.observation}
              </Text>
              <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
                {`Mechanism: ${entry.suspectedMechanism}`}
              </Text>
              <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
                {`Impact: ${entry.impact}`}
              </Text>
              <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
                {`Recommendation: ${entry.recommendation}`}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : (
        <EmptyState
          text={history ? "Notebook chưa có entry nào trong các dự án" : "Đang tải notebook…"}
          theme={theme}
        />
      )}
    </View>
  );
}

function DetectionPanel({
  theme,
  onOpenAgent,
}: {
  theme: PluginScreenProps["theme"];
  onOpenAgent(agentId: string): void;
}) {
  const getControlStatus = useRpc(controlStatus);
  const [control, setControl] = useState<RpcOutput<typeof controlStatus> | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await getControlStatus({});
        if (!disposed) {
          setControl(result);
          setControlError(null);
        }
      } catch (error) {
        if (!disposed) setControlError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 5000);
      }
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [getControlStatus]);

  const alerts = control?.alerts ?? [];
  const visible = showAll ? alerts.slice(0, 20) : alerts.slice(0, 3);
  return (
    <View style={{ gap: 6 }}>
      <SectionTitle icon="Radar" title="PHÁT HIỆN BẤT THƯỜNG" theme={theme} />
      <Text style={[styles.taskMeta, { color: theme.colors.foregroundMuted }]} numberOfLines={1}>
        {control
          ? `${control.mode} · ${control.embeddingModel} · MiniLM ${control.builtinModel.status} · JEV ${control.jevEnabled ? "bật" : "tắt"} · ${alerts.length} cảnh báo`
          : "Đang đọc trạng thái bộ dò…"}
      </Text>
      {controlError || control?.lastError || control?.builtinModel.error ? (
        <Text style={[styles.taskMeta, { color: theme.colors.statusDanger }]} numberOfLines={2}>
          {controlError ?? control?.lastError ?? control?.builtinModel.error}
        </Text>
      ) : null}
      {visible.map((alert) => (
        <View key={alert.id}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Mở cảnh báo ${alert.title}`}
            onPress={() => setExpanded((current) => (current === alert.id ? null : alert.id))}
            style={[
              styles.logRow,
              { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
            ]}
          >
            <Text style={[styles.monoSmall, { color: theme.colors.foregroundMuted }]}>
              {timeLabel(alert.timestamp)}
            </Text>
            <Text style={[styles.logText, { color: theme.colors.foreground }]} numberOfLines={1}>
              {alertSummary(alert)}
            </Text>
            <Icon
              name={expanded === alert.id ? "ChevronUp" : "ChevronDown"}
              size={13}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
          {expanded === alert.id ? (
            <View style={{ gap: 6, marginBottom: 7 }}>
              <AlertDetails alert={alert} theme={theme} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Mở agent ${alert.title}`}
                onPress={() => onOpenAgent(alert.agentId)}
                style={[styles.openAgentButton, { borderColor: theme.colors.border, marginTop: 0 }]}
              >
                <Text style={[styles.taskMeta, { color: theme.colors.foregroundMuted }]}>
                  Mở agent
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ))}
      {alerts.length > 3 ? (
        <Pressable accessibilityRole="button" onPress={() => setShowAll((current) => !current)}>
          <Text style={[styles.taskMeta, { color: theme.colors.accent }]}>
            {showAll ? "Thu gọn" : `Xem thêm (${alerts.length - 3})`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Alerts from control.status may omit delivery fields that have schema defaults. */
type AlertView = Omit<OvermindAlert, "supervisorDelivery" | "supervisorNotified" | "antiPatterns"> &
  Partial<Pick<OvermindAlert, "supervisorDelivery" | "supervisorNotified" | "antiPatterns">>;

function alertSummary(alert: AlertView): string {
  const delivery = alert.supervisorDelivery?.status === "sent" ? "đã báo" : "chờ báo";
  const signal = alert.antiPatterns?.join(", ") || alert.patterns.join(", ") || "ngữ nghĩa";
  return `${alert.title} · ${signal} · ${alert.tier} ${alert.score.toFixed(2)} · ${delivery}`;
}

function AlertDetails({ alert, theme }: { alert: AlertView; theme: PluginScreenProps["theme"] }) {
  const supervisorDelivery = alert.supervisorDelivery ?? {
    status: "queued" as const,
    agentId: null,
    error: null,
  };
  // The recipient is the source's parent role: a Lead for a Peer alert.
  let supervisorStatus = supervisorDelivery.error ?? "Chưa gửi được role cấp trên";
  if (supervisorDelivery.status === "sent") supervisorStatus = "Đã gửi role cấp trên";
  if (supervisorDelivery.status === "queued")
    supervisorStatus = "Đã xếp mailbox, chờ role cấp trên rảnh";
  return (
    <View
      style={[
        styles.alertDetails,
        { borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
      ]}
    >
      <Text style={[styles.taskMeta, { color: theme.colors.foregroundMuted }]} numberOfLines={3}>
        {alert.excerpt}
      </Text>
      {alert.jev ? (
        <Text style={[styles.taskMeta, { color: theme.colors.foregroundMuted }]}>
          JEV: {alert.jev.verdict} · confidence {alert.jev.confidence.toFixed(2)} · probability{" "}
          {alert.jev.probability.toFixed(2)}
        </Text>
      ) : null}
      <Text
        style={[
          styles.taskMeta,
          {
            color:
              supervisorDelivery.status === "sent"
                ? theme.colors.statusSuccess
                : theme.colors.statusWarning,
          },
        ]}
      >
        {supervisorStatus}
      </Text>
      {alert.error ? (
        <Text style={[styles.taskMeta, { color: theme.colors.statusDanger }]} numberOfLines={2}>
          {alert.error}
        </Text>
      ) : null}
    </View>
  );
}

/** One line in the agent timeline; details open on demand so the timeline does not jump. */
export function OvermindAlertView({ item, theme }: PluginTimelineItemProps<OvermindAlert>) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Overmind alert ${item.data.title}`}
        onPress={() => setOpen((current) => !current)}
        style={[
          styles.logRow,
          { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
        ]}
      >
        <Icon name="Radar" size={13} color={theme.colors.statusWarning} />
        <Text style={[styles.logText, { color: theme.colors.foreground }]} numberOfLines={1}>
          {alertSummary(item.data)}
        </Text>
        <Icon
          name={open ? "ChevronUp" : "ChevronDown"}
          size={13}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
      {open ? <AlertDetails alert={item.data} theme={theme} /> : null}
    </View>
  );
}

const styles = {
  flex: { flex: 1 },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: 16,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  headerTitle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, flex: 1 },
  logo: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 1,
  },
  titleLine: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    alignItems: "center" as const,
    gap: 8,
  },
  title: { fontSize: 20, fontWeight: "700" as const },
  subtitle: { fontSize: 12, marginTop: 4 },
  connection: { flexDirection: "row" as const, alignItems: "center" as const, gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  sectionTitle: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 7,
    marginBottom: 10,
  },
  grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 12 },
  diagram: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 8 },
  split: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 16 },
  diagramColumn: { width: 300, flexShrink: 0 },
  // Long trees, columns and notebooks scroll inside their panel instead of stretching the page.
  diagramBody: { maxHeight: 640 },
  columnBody: { maxHeight: 420 },
  notebookBody: { maxHeight: 520 },
  scrollBody: { gap: 8 },
  nodeCard: { borderWidth: 1, borderRadius: 10, padding: 9, gap: 5, width: "100%" as const },
  nodeName: { fontSize: 12, fontWeight: "600" as const, lineHeight: 16 },
  diagramHint: { fontSize: 11, marginBottom: 2 },
  rowBetween: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    alignSelf: "flex-start" as const,
  },
  monoSmall: { fontSize: 10, fontFamily: "monospace" },
  metricRow: {
    flexDirection: "row" as const,
    justifyContent: "space-between" as const,
    marginTop: 8,
  },
  track: { height: 6, borderRadius: 3, overflow: "hidden" as const },
  fill: { height: "100%" as const, borderRadius: 3 },
  mailbox: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 5,
    borderTopWidth: 1,
    paddingTop: 8,
    marginTop: 4,
  },
  taskGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 12 },
  column: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 8,
    minHeight: 180,
    minWidth: 190,
    flexGrow: 1,
    flexBasis: 190,
  },
  columnHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    paddingBottom: 8,
    borderBottomWidth: 1,
  },
  taskCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 5,
    minWidth: 0,
    flexShrink: 1,
    overflow: "hidden" as const,
  },
  taskTitle: { fontSize: 12, fontWeight: "600" as const },
  taskMeta: { fontSize: 11, lineHeight: 15 },
  wrapRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 5, marginTop: 3 },
  empty: {
    borderWidth: 1,
    borderRadius: 10,
    borderStyle: "dashed" as const,
    padding: 18,
    alignItems: "center" as const,
  },
  logRow: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 9,
    marginBottom: 7,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 10,
  },
  logText: { flex: 1, fontSize: 11 },
  alertDetails: { borderWidth: 1, borderRadius: 8, padding: 10, gap: 4 },
  openAgentButton: {
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginTop: 7,
    alignSelf: "flex-start" as const,
  },
  reviewInput: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 11,
    lineHeight: 15,
    textAlignVertical: "top" as const,
  },
  reviewButton: {
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignItems: "center" as const,
  },
  reviewButtonText: { fontSize: 11, fontWeight: "600" as const },
};

export const OvermindObservatoryView = OvermindCommandView;
export default OvermindCommandView;
