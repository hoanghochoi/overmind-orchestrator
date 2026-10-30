import { describe, expect, test } from "vitest";
import { rolePrompt } from "../modules/skills_engine.js";
import { LEAD_PROMPT, PEER_PROMPT, SUPERVISOR_PROMPT } from "./index.js";

describe("Overmind SLP prompts", () => {
  test("matches the canonical SLP instructions", () => {
    expect(SUPERVISOR_PROMPT).toContain(
      "You are an agent serving as a governance Supervisor for the Human owner, not a human operator.",
    );
    expect(LEAD_PROMPT).toContain(
      "You are an agent serving as Project Lead and binding technical arbiter",
    );
    expect(LEAD_PROMPT).toContain(
      "Enforce the Anti-Minting API rule (lock DB schemas & API contracts before TDD).",
    );
    expect(PEER_PROMPT).toContain(
      "You are an independent project Peer agent assigned one bounded outcome",
    );
    expect(PEER_PROMPT).toContain("REOPEN_REQUEST, DEPENDENCY_REQUEST, or BLOCKED");
    expect(PEER_PROMPT).toContain("proposing Option C when applicable");
    expect(PEER_PROMPT).toContain("Do not use web search, browser research, internet search");
    for (const prompt of [SUPERVISOR_PROMPT, LEAD_PROMPT, PEER_PROMPT]) {
      expect(prompt).not.toMatch(/\b(?:codex|claude|opencode|pi|agy)\b/i);
    }
  });
  test("Sup owns agreed-scope acceptance and Lead returns evidence instead of self-acceptance", () => {
    expect(SUPERVISOR_PROMPT).toContain("Own acceptance of your assigned Leads' handbacks");
    expect(SUPERVISOR_PROMPT).toContain(
      "Do not ask the Human to approve again what is already agreed",
    );
    expect(SUPERVISOR_PROMPT).toContain("needs_human with scope=change_required");
    expect(SUPERVISOR_PROMPT).not.toContain("or project acceptance");
    expect(LEAD_PROMPT).toContain("Do not self-accept your implementation");
  });

  test("adds runtime role metadata without changing the canonical instruction", () => {
    expect(PEER_PROMPT).toContain("Pushback Protocol");
    expect(rolePrompt("S")).toContain("Overmind role: supervisor.");
    expect(rolePrompt("L")).toContain("Overmind role: lead.");
    expect(rolePrompt("P")).toContain("Overmind role: peer.");
    for (const role of ["S", "L", "P"] as const) {
      expect(rolePrompt(role)).toContain(
        `multi_agent_version = '${role === "P" ? "disabled" : "paseo"}'`,
      );
    }
  });

  test("carries Law 0 into every role overlay", () => {
    const prompts = (["S", "L", "P", "supervisor", "lead", "peer"] as const).map(rolePrompt);
    for (const prompt of prompts) {
      expect(prompt).toContain("Overmind Law #0");
      expect(prompt).toContain("Documentation explains Why and What.");
      expect(prompt).toContain("Docstrings explain the Contract.");
      expect(prompt).toContain("Code shows How. Tests verify Correctness.");
      expect(prompt).toContain("Do not require docstrings for every function");
      expect(prompt).toContain("or repeat implementation details in documentation.");
      expect(prompt).toContain(
        "Keep documentation and docstrings consistent with each other and current code.",
      );
    }
  });

  test("carries agent identity and Peer intrinsic-capability laws into role overlays", () => {
    for (const role of ["S", "L", "P"] as const) {
      const prompt = rolePrompt(role);
      expect(prompt).toContain("Overmind Law #2: S/L/P seats are agents, not humans.");
      expect(prompt).toContain("Do not estimate, plan, or report work in human calendar units");
    }
    expect(rolePrompt("P")).toContain("Overmind Law #3: A Peer must not invoke web search");
    expect(rolePrompt("P")).toContain("must not invoke web search");
    expect(rolePrompt("L")).not.toContain("Overmind Law #3");
  });
});
