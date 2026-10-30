import type { PluginServerContext, PluginServerContribution } from "@getpaseo/plugin/server";
import contribute from "./server/index.js";

export default function overmind(
  server: PluginServerContext,
): ReturnType<PluginServerContribution> {
  return contribute(server);
}

// The implementation lives under server/ so plugin installation enforces the
// client/server module boundary before a bundle is accepted.
