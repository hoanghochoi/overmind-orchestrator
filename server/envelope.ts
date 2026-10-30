// Reader for the daemon's agent-message envelope (packages/server agent-messages/envelope.ts).
// Plugins receive prompts as provider timeline text, so provenance is recovered from it.
export interface EnvelopeSource {
  kind: "agent-message" | "agent-notification";
  agentId: string;
}
export interface EnvelopeMessage {
  source: EnvelopeSource | null;
  text: string;
}

function unescapeXml(value: string): string | null {
  if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entities[entity]!);
}

function parseAgentMessage(text: string): EnvelopeMessage | null {
  const envelope = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/.exec(
    text,
  );
  if (!envelope) return null;
  const attributes = new Map<string, string>();
  for (const match of envelope[1]!.matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    const value = unescapeXml(match[2]!);
    if (value === null || attributes.has(match[1]!)) return null;
    attributes.set(match[1]!, value);
  }
  const body = unescapeXml(envelope[2]!);
  if (attributes.get("version") !== "1" || !attributes.get("message-id") || body === null)
    return null;
  const kind = attributes.get("kind");
  if (kind === "user-message")
    return attributes.has("source-agent-id") ? null : { source: null, text: body };
  const agentId = attributes.get("source-agent-id");
  if ((kind !== "agent-message" && kind !== "agent-notification") || !agentId) return null;
  return { source: { kind, agentId }, text: body };
}

/** Accept only a complete sequence of envelopes; prose around them stays human text. */
export function parseAgentMessages(text: string): EnvelopeMessage[] | null {
  const messages = text.split(/(?<=<\/paseo-system>)\n+(?=<paseo-system )/).map(parseAgentMessage);
  return messages.every((message) => message !== null) ? messages : null;
}

/** Human text of a prompt; null when every part came from an agent. */
export function humanText(text: string): string | null {
  const messages = parseAgentMessages(text);
  if (!messages) return text;
  const human = messages.filter((message) => !message.source).map((message) => message.text);
  return human.length ? human.join("\n") : null;
}
