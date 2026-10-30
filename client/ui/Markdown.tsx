/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- React Native theme styles and link handlers are composed at render time. */
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState, type ReactNode } from "react";
import { Image, Linking, Text, View } from "react-native";
import { readImage } from "../../shared/control.js";

type Theme = PluginScreenProps["theme"];

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; marker: string; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "image"; alt: string; src: string };
/** A block and its position, which keys it when rendered. */
type KeyedBlock = Block & { id: number };

const IMAGE = /!\[([^\]]*)\]\(<?([^)\s>]+)>?\)/gu;
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/u;

/**
 * The subset of Markdown agents write in chat: fences, headings, lists, paragraphs, images,
 * bold, inline code and links. Images move out of their line into their own block.
 */
export function parseMarkdown(text: string): KeyedBlock[] {
  const blocks: KeyedBlock[] = [];
  const add = (block: Block) => blocks.push(Object.assign(block, { id: blocks.length }));
  let paragraph: string[] = [];
  let fence: string[] | null = null;
  const flush = () => {
    if (paragraph.length) add({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (const line of text.split(/\r?\n/u)) {
    if (line.trimStart().startsWith("```")) {
      if (fence) {
        add({ kind: "code", text: fence.join("\n") });
        fence = null;
      } else {
        flush();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const images = [...line.matchAll(IMAGE)];
    const rest = line.replace(IMAGE, "").trim();
    const heading = /^(#{1,6})\s+(.*)$/u.exec(rest);
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/u.exec(line.replace(IMAGE, ""));
    if (!rest) flush();
    else if (heading) {
      flush();
      add({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
    } else if (item) {
      flush();
      add({ kind: "item", marker: /\d/u.test(item[1]!) ? item[1]! : "•", text: item[2]! });
    } else paragraph.push(rest);
    if (images.length) {
      flush();
      for (const image of images) add({ kind: "image", alt: image[1]!, src: image[2]! });
    }
  }
  if (fence) add({ kind: "code", text: fence.join("\n") });
  flush();
  return blocks;
}

function inline(text: string, theme: Theme): ReactNode[] {
  const nodes: ReactNode[] = [];
  let at = 0;
  // Each part is keyed by where it starts in the text.
  for (const part of text.split(INLINE)) {
    if (part) nodes.push(inlinePart(part, at, theme));
    at += part.length;
  }
  return nodes;
}

function inlinePart(part: string, index: number, theme: Theme): ReactNode {
  if (part.startsWith("**") && part.endsWith("**"))
    return (
      <Text key={index} style={{ fontWeight: "700" }}>
        {part.slice(2, -2)}
      </Text>
    );
  if (part.startsWith("`") && part.endsWith("`"))
    return (
      <Text key={index} style={{ fontFamily: "monospace", backgroundColor: theme.colors.surface2 }}>
        {part.slice(1, -1)}
      </Text>
    );
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(part);
  if (link)
    return (
      <Text
        key={index}
        style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
        onPress={() => void Linking.openURL(link[2]!).catch(() => undefined)}
      >
        {link[1]}
      </Text>
    );
  return part;
}

export function Markdown({
  text,
  theme,
  size = 12,
}: {
  text: string;
  theme: Theme;
  /** Body text size; line height and headings scale from it. */
  size?: number;
}) {
  const color = theme.colors.foreground;
  const body = { fontSize: size, lineHeight: Math.round(size * 1.4) };
  return (
    <View style={{ gap: Math.round(size * 0.6) }}>
      {parseMarkdown(text).map((block) => {
        const index = block.id;
        switch (block.kind) {
          case "code":
            return (
              <Text
                key={index}
                selectable
                style={[
                  markdownStyles.code,
                  {
                    color,
                    backgroundColor: theme.colors.surface0,
                    borderColor: theme.colors.border,
                  },
                ]}
              >
                {block.text}
              </Text>
            );
          case "heading":
            return (
              <Text
                key={index}
                selectable
                style={[
                  body,
                  { color, fontWeight: "700", fontSize: size + Math.max(0, 4 - block.level) },
                ]}
              >
                {inline(block.text, theme)}
              </Text>
            );
          case "item":
            return (
              <View key={index} style={markdownStyles.item}>
                <Text style={[body, { color }]}>{block.marker}</Text>
                <Text selectable style={[body, { color, flex: 1 }]}>
                  {inline(block.text, theme)}
                </Text>
              </View>
            );
          case "image":
            return <ChatImage key={index} src={block.src} alt={block.alt} theme={theme} />;
          default:
            return (
              <Text key={index} selectable style={[body, { color }]}>
                {inline(block.text, theme)}
              </Text>
            );
        }
      })}
    </View>
  );
}

/** Data URIs per host path, so a re-render or live refetch does not read the file again. */
const imageCache = new Map<string, Promise<string>>();

function ChatImage({ src, alt, theme }: { src: string; alt: string; theme: Theme }) {
  const read = useRpc(readImage);
  const remote = /^(?:https?|data):/iu.test(src);
  const [uri, setUri] = useState<string | null>(remote ? src : null);
  const [error, setError] = useState<string | null>(null);
  const [ratio, setRatio] = useState(4 / 3);
  useEffect(() => {
    if (remote) return undefined;
    let disposed = false;
    let pending = imageCache.get(src);
    if (!pending) {
      pending = read({ path: src }).then((result) => result.dataUri);
      imageCache.set(src, pending);
      // A failed read is retried when the image appears again.
      pending.catch(() => imageCache.delete(src));
    }
    pending
      .then((dataUri) => {
        if (!disposed) setUri(dataUri);
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      disposed = true;
    };
  }, [read, remote, src]);
  useEffect(() => {
    if (!uri) return;
    Image.getSize(
      uri,
      (width, height) => {
        if (width && height) setRatio(width / height);
      },
      () => undefined,
    );
  }, [uri]);
  const name = alt || src.split(/[\\/]/u).pop() || src;
  if (error)
    return (
      <Text style={[markdownStyles.caption, { color: theme.colors.statusWarning }]}>
        Không hiển thị được {name}: {error}
      </Text>
    );
  return (
    <View style={{ gap: 3 }}>
      {uri ? (
        <Image
          accessibilityLabel={name}
          source={{ uri }}
          resizeMode="contain"
          style={[markdownStyles.image, { aspectRatio: ratio, borderColor: theme.colors.border }]}
        />
      ) : (
        <View
          style={[
            markdownStyles.image,
            {
              aspectRatio: ratio,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
            },
          ]}
        />
      )}
      <Text
        style={[markdownStyles.caption, { color: theme.colors.foregroundMuted }]}
        numberOfLines={1}
      >
        {name}
      </Text>
    </View>
  );
}

const markdownStyles = {
  code: {
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 16,
    borderWidth: 1,
    borderRadius: 6,
    padding: 8,
  },
  item: { flexDirection: "row" as const, gap: 6 },
  image: { width: "100%" as const, maxWidth: 420, borderWidth: 1, borderRadius: 8 },
  caption: { fontSize: 10, fontFamily: "monospace" },
};
