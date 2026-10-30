import { describe, expect, test } from "vitest";
import { buildAgentForest, isOvermindAgent } from "../client/agent-graph.js";

describe("Overmind graph", () => {
  test("accepts Overmind markers, rejects explicit opt-out and arbitrary roles", () => {
    expect(isOvermindAgent({})).toBe(false);
    expect(isOvermindAgent({ "overmind.role": "unrelated" })).toBe(false);
    expect(isOvermindAgent({ "overmind.enabled": "false", "overmind.role": "lead" })).toBe(false);
    expect(isOvermindAgent({ "overmind.enabled": "true" })).toBe(true);
    expect(isOvermindAgent({ "overmind.role": "SUPERVISOR" })).toBe(true);
    expect(isOvermindAgent({ "overmind.seat": "seat2" })).toBe(true);
    expect(isOvermindAgent({}, "overmind-supervisor")).toBe(true);
    expect(isOvermindAgent({ "overmind.enabled": "false" }, "overmind-supervisor")).toBe(false);
  });
  test("connects only declared parents on the same host", () => {
    const agents = [
      { id: "s", labels: {} },
      { id: "l", labels: { "paseo.parent-agent-id": "s" } },
      { id: "p", labels: { "paseo.parent-agent-id": "l", "paseo.parent-server-id": "here" } },
      {
        id: "external",
        labels: { "paseo.parent-agent-id": "s", "paseo.parent-server-id": "elsewhere" },
      },
      { id: "orphan", labels: { "paseo.parent-agent-id": "missing" } },
    ];
    const forest = buildAgentForest(agents, "here");
    expect(forest.map((node) => node.agent.id)).toEqual(["s", "external", "orphan"]);
    expect(forest[0].children[0].agent.id).toBe("l");
    expect(forest[0].children[0].children[0].agent.id).toBe("p");
  });
  test("keeps cycles visible without infinite traversal", () => {
    const agents = [
      { id: "a", labels: { "paseo.parent-agent-id": "b" } },
      { id: "b", labels: { "paseo.parent-agent-id": "a" } },
      { id: "self", labels: { "paseo.parent-agent-id": "self" } },
    ];
    expect(buildAgentForest(agents, "here").map((node) => node.agent.id)).toEqual([
      "a",
      "b",
      "self",
    ]);
  });
});
