/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- React Native theme styles are composed at render time. */
import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { ChatItem } from "./ChatTimeline.js";

type Theme = PluginScreenProps["theme"];
type TimelinePage = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>;
type TimelineEntry = TimelinePage["entries"][number];

/** Entries per page: the live tail, and each older page the owner asks for. */
const CHAT_LIMIT = 80;
/** Within this distance of the bottom the chat follows new output. */
const STICK_DISTANCE = 40;
// The page scrolls too; on web the chat keeps its wheel instead of handing it to the page.
const CONTAIN_SCROLL = Platform.OS === "web" ? ({ overscrollBehavior: "contain" } as object) : null;
/** Live events arrive per token; one refetch per burst keeps the console current. */
const REFRESH_DELAY_MS = 400;

export interface ConsoleAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  driver: string;
  model: string;
  tokenCount: string;
}

/** The selected seat's live chat, what it is doing now, and a composer to intervene. */
export function AgentConsole({
  agent,
  doing,
  theme,
  onOpenAgent,
}: {
  agent: ConsoleAgent;
  /** One line per fact about the seat's current state, most important first. */
  doing: readonly string[];
  theme: Theme;
  onOpenAgent?: () => void;
}) {
  const paseo = usePaseo();
  const [tail, setTail] = useState<TimelineEntry[]>([]);
  const [older, setOlder] = useState<TimelineEntry[]>([]);
  // Where the next older page starts; set by the first tail, then by each older page.
  const [olderCursor, setOlderCursor] = useState<TimelinePage["startCursor"]>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scroller = useRef<{ scrollToEnd?(options: { animated: boolean }): void } | null>(null);
  const stick = useRef(true);
  const paged = useRef(false);

  useEffect(() => {
    const timeline = paseo.agents.ref(agent.id).timeline;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      timeline
        .refetch({ direction: "tail", limit: CHAT_LIMIT })
        .then((page) => {
          if (disposed) return undefined;
          setTail(page.entries);
          setLoadError(page.error);
          if (!paged.current) {
            setOlderCursor(page.startCursor);
            setHasOlder(page.hasOlder);
          }
          return undefined;
        })
        .catch((error: unknown) => {
          if (!disposed) setLoadError(error instanceof Error ? error.message : String(error));
        });
    void load();
    const subscription = timeline.subscribe(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void load();
      }, REFRESH_DELAY_MS);
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      subscription();
    };
  }, [paseo, agent.id]);

  async function loadOlder() {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    stick.current = false;
    try {
      const page = await paseo.agents
        .ref(agent.id)
        .timeline.refetch({ direction: "before", cursor: olderCursor, limit: CHAT_LIMIT });
      paged.current = true;
      setOlder((current) => [...page.entries, ...current]);
      setOlderCursor(page.startCursor);
      setHasOlder(page.hasOlder);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingOlder(false);
    }
  }

  // The live tail is refetched whole; older pages stop where it begins.
  const firstLive = tail[0]?.seqStart ?? Number.POSITIVE_INFINITY;
  const entries = [...older.filter((entry) => entry.seqStart < firstLive), ...tail];

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setSendError(null);
    try {
      await paseo.agents.ref(agent.id).send(text);
      setDraft("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  const muted = theme.colors.foregroundMuted;
  return (
    <View
      style={[
        consoleStyles.panel,
        { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
      ]}
    >
      <View style={consoleStyles.header}>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={[consoleStyles.name, { color: theme.colors.foreground }]} numberOfLines={1}>
            {agent.name}
          </Text>
          <Text style={[consoleStyles.mono, { color: muted }]} numberOfLines={1}>
            {agent.role} · {agent.status} · {agent.driver}/{agent.model} · {agent.tokenCount}
          </Text>
        </View>
        {onOpenAgent ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${agent.name} agent`}
            onPress={onOpenAgent}
            style={[consoleStyles.smallButton, { borderColor: theme.colors.border }]}
          >
            <Text style={[consoleStyles.buttonText, { color: muted }]}>Mở agent</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={[consoleStyles.doing, { borderColor: theme.colors.border }]}>
        {doing.map((line) => (
          <Text key={line} style={[consoleStyles.doingLine, { color: theme.colors.foreground }]}>
            {line}
          </Text>
        ))}
      </View>
      <ScrollView
        ref={scroller as never}
        style={[consoleStyles.chat, CONTAIN_SCROLL]}
        contentContainerStyle={{ gap: 4, paddingHorizontal: 16, paddingVertical: 8 }}
        scrollEventThrottle={100}
        onScroll={(event) => {
          const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
          stick.current =
            contentOffset.y + layoutMeasurement.height >= contentSize.height - STICK_DISTANCE;
        }}
        onContentSizeChange={() => {
          if (stick.current) scroller.current?.scrollToEnd?.({ animated: false });
        }}
      >
        {hasOlder ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Load older messages"
            disabled={loadingOlder}
            onPress={() => void loadOlder()}
            style={[
              consoleStyles.smallButton,
              consoleStyles.older,
              { borderColor: theme.colors.border },
            ]}
          >
            <Text style={[consoleStyles.buttonText, { color: muted }]}>
              {loadingOlder ? "Đang tải…" : "Tải tin cũ hơn"}
            </Text>
          </Pressable>
        ) : null}
        {entries.length ? (
          entries.map((entry) => <ChatItem key={entry.seqStart} item={entry.item} theme={theme} />)
        ) : (
          <Text style={[consoleStyles.mono, { color: muted }]}>
            {loadError ?? "Chưa có hoạt động."}
          </Text>
        )}
      </ScrollView>
      <View
        style={[
          consoleStyles.composer,
          { backgroundColor: theme.colors.surface0, borderColor: theme.colors.border },
        ]}
      >
        <TextInput
          accessibilityLabel={`Message ${agent.name}`}
          value={draft}
          onChangeText={setDraft}
          placeholder="Gửi chỉ dẫn hoặc yêu cầu kiểm tra trực tiếp…"
          placeholderTextColor={muted}
          multiline
          editable={!sending}
          style={[consoleStyles.input, { color: theme.colors.foreground }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send intervention to selected Overmind agent"
          disabled={sending || !draft.trim()}
          onPress={() => void send()}
          style={[
            consoleStyles.sendButton,
            {
              backgroundColor:
                sending || !draft.trim() ? theme.colors.surface2 : theme.colors.accent,
            },
          ]}
        >
          <Icon
            name={sending ? "Loader" : "ArrowUp"}
            size={16}
            color={
              sending || !draft.trim()
                ? theme.colors.foregroundMuted
                : theme.colors.accentForeground
            }
          />
        </Pressable>
      </View>
      {sendError ? (
        <Text style={[consoleStyles.mono, { color: theme.colors.statusDanger }]}>{sendError}</Text>
      ) : null}
    </View>
  );
}

const consoleStyles = {
  panel: { flex: 1, minWidth: 0, borderWidth: 1, borderRadius: 14, padding: 12, gap: 10 },
  header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
  name: { fontSize: 15, fontWeight: "700" as const },
  mono: { fontFamily: "monospace", fontSize: 11 },
  doing: { borderWidth: 1, borderRadius: 8, padding: 8, gap: 3 },
  doingLine: { fontSize: 12, lineHeight: 17 },
  chat: { height: 560, flexGrow: 0 },
  // The native composer: one rounded field with the send button inside it.
  composer: {
    flexDirection: "row" as const,
    alignItems: "flex-end" as const,
    gap: 8,
    borderWidth: 1,
    borderRadius: 16,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
  },
  input: { flex: 1, minHeight: 24, maxHeight: 160, paddingVertical: 4, fontSize: 15 },
  sendButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  older: { alignSelf: "center" as const },
  smallButton: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 5 },
  buttonText: { fontSize: 12, fontWeight: "600" as const },
};
