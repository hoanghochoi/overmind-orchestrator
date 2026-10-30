import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { OvermindAlert } from "../shared/control.js";
import { CausalNotebook, type CausalObservation } from "./modules/causal_notebook.js";
import { projectRoot } from "./project-history.js";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

function timelineEvidence(
  items: readonly { item: AgentTimelineItem }[],
): CausalObservation["evidence"] {
  const evidence: CausalObservation["evidence"] = [];
  for (const { item } of items) {
    if (evidence.length >= 19) break;
    if (item.type === "reasoning" && item.text.trim())
      evidence.push({ kind: "reasoning_summary", content: item.text.slice(-8000) });
    if (item.type === "assistant_message" && item.text.trim())
      evidence.push({ kind: "quote", content: item.text.slice(-8000) });
    if (item.type === "tool_call")
      evidence.push({ kind: "tool_output", content: JSON.stringify(item).slice(-8000) });
  }
  return evidence;
}

export async function findNotebookSupervisor(source: PluginHookAgent, paseo: PaseoApi) {
  let id: string | null = source.id;
  const visited = new Set<string>();
  while (id && !visited.has(id) && visited.size < 4) {
    visited.add(id);
    const current = await paseo.agents.ref(id).refresh();
    if (!current || current.agent.archivedAt) break;
    if (current.agent.provider === "overmind-supervisor") return current.agent;
    id = current.agent.labels["paseo.parent-agent-id"] ?? null;
  }
  return null;
}

/** Sensor input is evidence, not a confirmed causal diagnosis. */
export async function captureNotebookAlert(
  source: PluginHookAgent,
  turnId: string | null,
  alert: OvermindAlert,
  paseo: PaseoApi,
  stateDirectory: string,
) {
  if (!source.workspaceId) throw new Error("Notebook capture requires a target workspace");
  const supervisor = await findNotebookSupervisor(source, paseo);
  if (!supervisor)
    throw new Error("Notebook capture requires an active Overmind Supervisor ancestor");
  const root = await projectRoot(paseo, source.workspaceId);
  const ref = paseo.agents.ref(source.id);
  const [snapshot, timeline] = await Promise.all([
    ref.refresh(),
    ref.timeline.refetch({ direction: "tail", limit: 20 }),
  ]);
  // Repetition (structural) alerts come from neither sensor tier.
  const TIERS = { regex: 1, semantic: 2, hybrid: 2, structural: null } as const;
  const tier = TIERS[alert.tier];
  const evidence: CausalObservation["evidence"] = [
    {
      kind: "sensor",
      content: alert.excerpt || "Sensor alert",
      metadata: {
        tier,
        detector: alert.tier,
        score: alert.score,
        patterns: alert.patterns,
        turn_id: turnId,
        alert_id: alert.id,
      },
    },
  ];
  evidence.push(...timelineEvidence(timeline.entries));
  return new CausalNotebook(root, stateDirectory).write(
    { provider: supervisor.provider, agentId: supervisor.id },
    {
      workspace_id: source.workspaceId,
      session_id: snapshot?.agent.persistence?.sessionId ?? source.id,
      observation: `${tier ? `Tier-${tier}` : "Structural"} workflow alert: ${alert.patterns.join(", ") || "semantic similarity"}`,
      evidence,
      suspected_mechanism: "Unconfirmed sensor hypothesis; Supervisor causal review required",
      impact: "Potential workflow disruption; severity has not been assessed",
      recommendation:
        "Review the cited evidence, determine the mechanism and impact, then decide whether intervention is warranted",
      protocol_candidate: false,
      anti_pattern:
        alert.antiPatterns.join(",") || alert.patterns.join(",") || "semantic-similarity",
      alert_id: alert.id,
    },
    true,
  );
}
