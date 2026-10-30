/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- React Native theme styles are composed at render time. */
import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Markdown } from "./Markdown.js";

type Theme = PluginScreenProps["theme"];
type TimelineItem = Awaited<
  ReturnType<PaseoAgentTimelineHandle["refetch"]>
>["entries"][number]["item"];
type ToolCallItem = Extract<TimelineItem, { type: "tool_call" }>;

/*
 * Spacing, radii and type sizes follow the native agent chat (packages/app message.tsx):
 * a 4px rhythm, 15px content text, a right-aligned user bubble and borderless assistant text.
 */
const CONTENT = 15;
const LABEL = 14;
const META = 13;

/** Overmind and other agents deliver messages wrapped in a paseo-system envelope. */
export function unwrapMessage(text: string): { from: string | null; text: string } {
  const match = /^<paseo-system[^>]*>\n?([\s\S]*?)\n?<\/paseo-system>\s*$/u.exec(text.trim());
  if (!match) return { from: null, text };
  const from = /source-agent-title="([^"]*)"/u.exec(text)?.[1] ?? "Overmind";
  return { from, text: match[1]! };
}

const TOOL_ICONS: Readonly<Record<string, string>> = {
  shell: "SquareTerminal",
  read: "FileText",
  edit: "Pencil",
  write: "FilePlus",
  search: "Search",
  fetch: "Globe",
  sub_agent: "Bot",
  plan: "ListTodo",
  worktree_setup: "GitBranch",
};

export function ChatItem({ item, theme }: { item: TimelineItem; theme: Theme }) {
  const muted = theme.colors.foregroundMuted;
  switch (item.type) {
    case "user_message": {
      const message = unwrapMessage(item.text);
      return (
        <View style={chatStyles.userRow}>
          {message.from ? (
            <Text style={[chatStyles.meta, { color: muted }]}>{message.from}</Text>
          ) : null}
          <View style={[chatStyles.userBubble, { backgroundColor: theme.colors.surface2 }]}>
            <Markdown text={message.text} theme={theme} size={CONTENT} />
          </View>
        </View>
      );
    }
    case "assistant_message":
      return (
        <View style={chatStyles.assistant}>
          <Markdown text={item.text} theme={theme} size={CONTENT} />
        </View>
      );
    case "reasoning":
      return (
        <Expandable theme={theme} icon="Brain" label="Thinking">
          <Text selectable style={[chatStyles.detailText, { color: muted }]}>
            {item.text}
          </Text>
        </Expandable>
      );
    case "tool_call":
      return <ToolCall item={item} theme={theme} />;
    case "todo":
      return (
        <View style={[chatStyles.card, { borderColor: theme.colors.border }]}>
          {item.items.map((task, index) => (
            <View key={task.id ?? index} style={chatStyles.todoRow}>
              <Icon
                name={task.completed ? "CircleCheck" : "Circle"}
                size={14}
                color={task.completed ? theme.colors.statusSuccess : muted}
              />
              <Text
                style={[
                  chatStyles.label,
                  {
                    color: task.completed ? muted : theme.colors.foreground,
                    textDecorationLine: task.completed ? "line-through" : "none",
                  },
                ]}
              >
                {task.text}
              </Text>
            </View>
          ))}
        </View>
      );
    case "error":
      return <Notice theme={theme} level="error" message={item.message} />;
    case "notification":
      return <Notice theme={theme} level={item.level} message={item.message} />;
    case "compaction":
      return (
        <Text style={[chatStyles.meta, chatStyles.center, { color: muted }]}>Đã nén ngữ cảnh</Text>
      );
    default:
      return null;
  }
}

function ToolCall({ item, theme }: { item: ToolCallItem; theme: Theme }) {
  const display = buildToolCallDisplayModel(item);
  const failed = item.status === "failed";
  const detail = [display.summary, display.errorText].filter(Boolean).join("\n\n");
  return (
    <Expandable
      theme={theme}
      icon={TOOL_ICONS[item.detail.type] ?? "Wrench"}
      label={display.displayName}
      secondary={display.summary}
      tone={toolTone(item.status, theme)}
    >
      {detail ? (
        <Text
          selectable
          style={[
            chatStyles.detailText,
            chatStyles.mono,
            { color: failed ? theme.colors.statusDanger : theme.colors.foregroundMuted },
          ]}
        >
          {detail}
        </Text>
      ) : null}
    </Expandable>
  );
}

/** Like native tool calls: failures in red, a running call brighter than finished ones. */
function toolTone(status: ToolCallItem["status"], theme: Theme): string | undefined {
  if (status === "failed") return theme.colors.statusDanger;
  return status === "running" ? theme.colors.foreground : undefined;
}

/** A one-line badge that opens its detail, like native tool calls and reasoning. */
function Expandable({
  theme,
  icon,
  label,
  secondary,
  tone,
  children,
}: {
  theme: Theme;
  icon: string;
  label: string;
  secondary?: string;
  tone?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const color = tone ?? theme.colors.foregroundMuted;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        disabled={!children}
        onPress={() => setOpen((value) => !value)}
        style={[
          chatStyles.badge,
          open
            ? {
                borderColor: theme.colors.border,
                borderBottomLeftRadius: 0,
                borderBottomRightRadius: 0,
              }
            : null,
        ]}
      >
        <View style={chatStyles.badgeIcon}>
          <Icon name={icon} size={14} color={color} />
        </View>
        <Text style={[chatStyles.label, { color }]} numberOfLines={1}>
          {label}
        </Text>
        {secondary ? (
          <Text
            style={[
              chatStyles.label,
              chatStyles.secondary,
              { color: theme.colors.foregroundMuted },
            ]}
            numberOfLines={1}
          >
            {secondary}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {children ? (
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            size={14}
            color={theme.colors.foregroundMuted}
          />
        ) : null}
      </Pressable>
      {open && children ? (
        <View style={[chatStyles.detail, { borderColor: theme.colors.border }]}>{children}</View>
      ) : null}
    </View>
  );
}

const NOTICE_BACKGROUNDS = {
  info: "rgba(147, 197, 253, 0.1)",
  warning: "rgba(245, 158, 11, 0.1)",
  error: "rgba(239, 68, 68, 0.1)",
} as const;

function Notice({
  theme,
  level,
  message,
}: {
  theme: Theme;
  level: keyof typeof NOTICE_BACKGROUNDS;
  message: string;
}) {
  const color = {
    error: theme.colors.statusDanger,
    warning: theme.colors.statusWarning,
    info: theme.colors.foregroundMuted,
  }[level];
  return (
    <View style={[chatStyles.notice, { backgroundColor: NOTICE_BACKGROUNDS[level] }]}>
      <Icon name={level === "info" ? "Info" : "TriangleAlert"} size={14} color={color} />
      <Text selectable style={[chatStyles.label, { color: theme.colors.foreground, flex: 1 }]}>
        {message}
      </Text>
    </View>
  );
}

const chatStyles = {
  userRow: { alignItems: "flex-end" as const, gap: 4, marginVertical: 12 },
  userBubble: {
    borderRadius: 16,
    borderTopRightRadius: 2,
    paddingHorizontal: 16,
    paddingVertical: 12,
    maxWidth: "88%" as const,
    flexShrink: 1,
  },
  assistant: { paddingVertical: 12 },
  meta: { fontSize: META },
  center: { alignSelf: "center" as const, marginVertical: 8 },
  label: { fontSize: LABEL, lineHeight: 20 },
  secondary: { flex: 1, minWidth: 0, marginLeft: 8 },
  mono: { fontFamily: "monospace", fontSize: 12, lineHeight: 18 },
  badge: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginHorizontal: -9,
  },
  badgeIcon: {
    width: 22,
    height: 22,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginRight: 4,
  },
  detail: {
    borderWidth: 1,
    borderTopWidth: 0,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    padding: 12,
    marginHorizontal: -9,
    marginBottom: 4,
  },
  detailText: { fontSize: 13, lineHeight: 19 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6, marginVertical: 4 },
  todoRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
  notice: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: 8,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginVertical: 4,
  },
};
