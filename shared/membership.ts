import { roleForProvider } from "./providers.js";

export function isOvermindAgent(
  labels: Readonly<Record<string, string>>,
  provider?: string,
): boolean {
  const enabled = labels["overmind.enabled"]?.toLowerCase();
  if (enabled === "false") return false;
  return (
    enabled === "true" ||
    (provider !== undefined && roleForProvider(provider) !== null) ||
    ["supervisor", "lead", "peer"].includes(labels["overmind.role"]?.toLowerCase() ?? "") ||
    ["seat1", "seat2"].includes(labels["overmind.seat"] ?? "")
  );
}
