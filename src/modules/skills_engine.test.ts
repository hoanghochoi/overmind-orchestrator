import { describe, expect, test } from "vitest";
import { ContractLock, SkillFilteringEngine } from "./skills_engine.js";

describe("Overmind governance guards", () => {
  test("only Supervisor receives the task adjudication tool", () => {
    const engine = new SkillFilteringEngine();
    expect(engine.isAllowed("supervisor", "overmind_task_review")).toBe(true);
    expect(engine.isAllowed("lead", "overmind_task_review")).toBe(false);
    expect(engine.isAllowed("peer", "overmind_task_review")).toBe(false);
    for (const skill of ["paseo", "paseo-handoff", "paseo-committee"])
      expect(engine.isAllowed("peer", skill)).toBe(false);
    expect(engine.isAllowed("peer", "9router-image")).toBe(true);
  });
  test("denied skills win over wildcard grants", () => {
    const engine = new SkillFilteringEngine({
      peer: { allowed_skills: ["*"], denied_skills: ["secret:*"] },
    });
    expect(engine.filter("peer", ["code_writer", "secret:deploy"])).toEqual(["code_writer"]);
  });

  test("blocks peer tests until both contracts are locked", () => {
    const lock = new ContractLock();
    expect(() => lock.assertPeerTestGenerationAllowed()).toThrow(/Anti-Minting/);
    lock.lockDatabaseSchema({ at: "2026-01-01T00:00:00.000Z" });
    lock.lockApiContract({ at: "2026-01-01T00:00:00.000Z" });
    expect(lock.canGeneratePeerTests()).toBe(true);
  });

  test("disables native sub-agents for every S/L/P role", () => {
    const engine = new SkillFilteringEngine();
    for (const role of ["supervisor", "lead", "peer", "S", "L", "P"] as const) {
      expect(engine.nativeSubagentsEnabled(role)).toBe(false);
      expect(engine.overlay(role).multi_agent_version).toBe(
        role === "peer" || role === "P" ? "disabled" : "paseo",
      );
    }
  });

  test("keeps native sub-agent spawning denied under wildcard custom policies", () => {
    const engine = new SkillFilteringEngine({
      supervisor: { allowed_skills: ["*"], denied_skills: [] },
      lead: { allowed_skills: ["*"], denied_skills: [] },
      peer: { allowed_skills: ["*"], denied_skills: [] },
    });
    for (const role of ["supervisor", "lead", "peer"] as const) {
      expect(engine.isAllowed(role, "native_subagent_spawn")).toBe(false);
      expect(engine.overlay(role).denied_skills).toContain("native_subagent_spawn");
    }
  });

  test("keeps Peer web search denied under wildcard custom policies", () => {
    const engine = new SkillFilteringEngine({
      peer: { allowed_skills: ["*"], denied_skills: [] },
    });
    for (const skill of [
      "websearch",
      "web_search",
      "webfetch",
      "web_fetch",
      "browser_search",
      "browser:webfetch",
      "search:web",
      "internet_search",
      "external_search:provider",
    ]) {
      expect(engine.isAllowed("peer", skill)).toBe(false);
    }
    expect(engine.isAllowed("peer", "code_writer")).toBe(true);
  });
});
