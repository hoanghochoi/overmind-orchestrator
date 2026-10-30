interface GraphAgent {
  id: string;
  labels: Readonly<Record<string, string>>;
}
export interface AgentBranchNode<T> {
  agent: T;
  children: AgentBranchNode<T>[];
}

export { isOvermindAgent } from "../shared/membership.js";

export function buildAgentForest<T extends GraphAgent>(
  agents: readonly T[],
  hostId: string,
): AgentBranchNode<T>[] {
  const nodes = new Map<string, AgentBranchNode<T>>(
    agents.map((agent) => [agent.id, { agent, children: [] }]),
  );
  function parentId(agent: T): string | undefined {
    const server = agent.labels["paseo.parent-server-id"];
    if (server && server !== hostId) return undefined;
    const id = agent.labels["paseo.parent-agent-id"];
    return nodes.has(id) ? id : undefined;
  }
  const roots: AgentBranchNode<T>[] = [];
  for (const node of nodes.values()) {
    const parent = parentId(node.agent);
    let cursor = parent;
    const seen = new Set([node.agent.id]);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentId(nodes.get(cursor)!.agent);
    }
    // Corrupt lineage stays visible as roots instead of recursing forever.
    if (parent && !cursor) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}
