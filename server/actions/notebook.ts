import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CausalNotebook,
  CausalObservationSchema,
  NOTEBOOK_TOOLS,
  assertNotebookSupervisor,
  type NotebookPrincipal,
} from "../modules/causal_notebook.js";

export const NotebookScopeSchema = z.object({ workspace_id: z.string().min(1) }).strict();
export const NotebookReadSchema = NotebookScopeSchema.extend({
  anti_pattern: z.string().optional(),
  keyword: z.string().optional(),
});
export const NotebookWriteSchema = CausalObservationSchema;
export const NotebookProposeSchema = NotebookScopeSchema.extend({
  anti_pattern: z.string().min(1),
});
export const NOTEBOOK_ACTION_SCHEMAS = {
  causal_notebook_write: NotebookWriteSchema,
  causal_notebook_read: NotebookReadSchema,
  causal_notebook_propose_protocol: NotebookProposeSchema,
};

export async function proposeProtocol(
  notebook: CausalNotebook,
  principal: NotebookPrincipal,
  input: z.infer<typeof NotebookProposeSchema>,
  cwd: string,
) {
  const entries = (await notebook.read(principal, { anti_pattern: input.anti_pattern })).filter(
    (entry) => entry.protocol_candidate,
  );
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = entry.suspected_mechanism.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const recurring = [...groups.values()].find(
    (items) => new Set(items.map((entry) => entry.session_id)).size >= 2,
  );
  if (!recurring)
    return {
      proposed: false,
      reason: "At least two distinct sessions with the same causal mechanism are required",
      patch: null,
    };
  let original = "";
  let exists = true;
  try {
    original = await readFile(join(cwd, "WORKSPACE_PROTOCOL.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  const safe = (value: string) => value.replace(/[\r\n]/g, " ").slice(0, 2000);
  const addition = [
    "",
    `## Governance candidate: ${safe(input.anti_pattern)}`,
    "",
    `Observed mechanism (hypothesis): ${safe(recurring[0].suspected_mechanism)}`,
    `Recovery rule: ${safe(recurring.at(-1)!.recommendation)}`,
    `Evidence entries: ${recurring.map((entry) => entry.id).join(", ")}`,
    "",
    "Owner review is required before adopting this candidate.",
    "",
  ];
  const lines = original ? original.replace(/\n$/, "").split("\n") : [];
  const updated = [...lines, ...addition];
  const patch =
    [
      exists ? "--- a/WORKSPACE_PROTOCOL.md" : "--- /dev/null",
      "+++ b/WORKSPACE_PROTOCOL.md",
      `@@ -${lines.length ? 1 : 0},${lines.length} +1,${updated.length} @@`,
      ...lines.map((line) => `-${line}`),
      ...(original && !original.endsWith("\n") ? ["\\ No newline at end of file"] : []),
      ...updated.map((line) => `+${line}`),
    ].join("\n") + "\n";
  return {
    proposed: true,
    patch,
    base_sha256: createHash("sha256").update(original).digest("hex"),
    entry_ids: recurring.map((entry) => entry.id),
  };
}

/**
 * Principal and placement come from the daemon-bound MCP capability, never tool arguments.
 * The notebook is per project: workspace_id only picks the project, reads span all of it.
 */
export function createNotebookActions(
  resolveProjectRoot: (workspaceId: string) => Promise<string>,
  stateDirectory: string,
) {
  return new Map(
    NOTEBOOK_TOOLS.map((name) => [
      name,
      async (principal: NotebookPrincipal, raw: unknown) => {
        assertNotebookSupervisor(principal);
        const input = NOTEBOOK_ACTION_SCHEMAS[name].parse(raw);
        const cwd = await resolveProjectRoot(input.workspace_id);
        const notebook = new CausalNotebook(cwd, stateDirectory);
        if (name === "causal_notebook_write")
          return notebook.write(principal, NotebookWriteSchema.parse(input));
        if (name === "causal_notebook_read") {
          const { anti_pattern, keyword } = NotebookReadSchema.parse(input);
          return notebook.read(principal, { anti_pattern, keyword });
        }
        return proposeProtocol(notebook, principal, NotebookProposeSchema.parse(input), cwd);
      },
    ]),
  );
}
