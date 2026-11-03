# Overmind Command

Overmind routes Human → `overmind-supervisor` → `overmind-lead` → `overmind-peer`.
Use the Supervisor conversation for normal tasks and owner decisions. The Human can
also message Lead or Peer directly. A direct Human message to a Peer queues a notice
and its completion result to that Peer's actual Lead, without steering a busy Lead.
Parent identity and workspace ownership do not change. Leads coordinate the
assigned project and Peers implement bounded tasks or review them; Overmind reports
delegated work back to its requester at the first turn that ends with nothing of the
child's own still out: a Lead that dispatched a Peer and ended its turn reports to its
Supervisor only after the Peer's result came back and the Lead finished with it. Parents
wait idle for these reports, so pending reports and queued notices persist in
`~/.overmind/paseo-plugin/relay.json` across plugin reloads.
A Lead that needs a Supervisor decision mid-task calls `ask_supervisor`: the question goes
up at once (queued while the Supervisor is busy), the Lead waits idle with a `HỎI SUP`
chip, and its task report stays held until the Supervisor answers with
`send_agent_prompt` or the Human answers the Lead directly.

For a deferred governance check, the Supervisor can call `create_supervisor_wake`
with `cron` and an optional IANA `timezone` (default UTC), then end its turn.
Only the next matching time runs: the backend fixes `maxRuns: 1` and the target
to that authenticated Supervisor's current agent ID. The prompt resumes governance
of existing work; the action accepts no target, provider, model, or custom prompt.
Lead and Peer cannot call it, and raw Paseo scheduler tools remain disabled.
The host's Paseo CLI must be available through `PASEO_CLI` (Desktop sets it) or
`PATH`; it uses the daemon's `PASEO_HOME`, or the default `~/.paseo`.

The Human's product intent lives per project in `~/.overmind/paseo-plugin/intent.json`,
outside any one task. The Supervisor registers questions with `product_intent` action
`ask` (its card shows `HỎI ĐẠI CA · n`), asks them in its own reply, and records the answers
with `record`, which refuses quotes that are not in the Human's messages to it. Supervisor
and Lead read it before framing work, so a recorded answer is not asked again. The diagram exposes the actual agent/provider/parent links.
`create_agent` titles each child `<Name> - <Role> - <task>`, with the name drawn at random from
20 great minds not carried by a live agent (`server/names.ts`). A new Lead also titles its
workspace; Paseo cannot retitle an agent, so a later `task` on `send_agent_prompt` retitles only
the Lead's workspace.

Supervisor and Lead use `featureValues.multi_agent_version = "paseo"`; Peer stays
`"disabled"` because it cannot create children. These are Overmind policy values,
not Codex provider options. Native provider sub-agents remain disabled so all children
have the configured role provider and a real parent. Supervisor can provision or
coordinate Leads across local workspaces and projects; existing Leads keep their
parent and workspace. Archive requires ownership. A Peer stays in its Lead's workspace. Each role
keeps its physical provider home. Supervisor launches read-only. Peer launches with
workspace write and network access; only web search is denied to it. A permission mode
chosen in Settings still replaces these defaults.

## Released Paseo hosts

The plugin runs on released Paseo (0.13.2) without a custom daemon build. It owns
its authority instead of relying on host policy:

- Overmind profiles publish `paseoTools.enabled=false`, so seats cannot reach the
  raw Paseo tools. Supervisor and Lead coordinate through the plugin's local
  `overmind` MCP server, which checks the caller's live role, ownership and
  workspace on every call. Their provider tool policy preapproves exactly those
  tools; the daemon accepts a preapproval only for a server shipped in the same
  request, which is why the raw `paseo` server is never preapproved.
- `agent.create` cannot see the requested parent, so creating `overmind-lead` or
  `overmind-peer` needs a one-time ticket. The Overmind tools issue it for the
  next role; nothing else can create a Lead or Peer.
- Plugins can only set agent labels at creation. Turn, review, agreement and
  contract state live in `~/.overmind/paseo-plugin/seats.json`, and the
  Command screen overlays them on agent labels through `seat.labels`. `paseo ls`
  does not show them.
- The plugin queues agent notices until the recipient is idle and reports a
  delegated turn's result to whoever dispatched it.

What the plugin cannot enforce on a released host: a Human's direct prompt to a
Peer is not gated by the contract lock (its Lead is still told, with the result);
ordinary agents that keep the Paseo tools can still message, archive or create
Overmind seats; there is no `cancel_agent`.

Existing seats created before this design hold stale MCP endpoints. Recreate them
after reloading the plugin, then run Settings → sync so the profiles carry
`paseoTools.enabled=false`. Provider selection and authentication remain
host-owned; role-home authentication must be provisioned on the host.

Open Settings from the Overmind Command header to select providers, models, thinking levels and, for Supervisor, Lead and Peer, a permission mode from the provider's own modes. The mode applies when Overmind creates the seat; an empty choice keeps the provider default. Provider model pickers support search and scrolling. Profile publishing currently supports Claude, Codex, OpenCode and Pi; Scout and Preview accept other available providers, including Antigravity, but their dedicated execution workflows are not connected yet. Settings apply to new agents.

There is one Peer profile. The Lead passes an `effort` to `create_agent` or `dual_seat`; it must be a thinking level the Peer's model offers. Profiles left from the removed Peer kinds (`overmind-peer-<kind>`) are disabled on the next registration; their live seats are still Peers.

Paseo 0.13 rejects a profile that extends a plugin provider, so the `antigravity` plugin provider cannot back a seat. An ACP provider can: one whose command is `agy-acp` is treated as the Antigravity driver, and it is accepted for Peers only, since AGY offers no read-only mode for a Supervisor.

Role limits per provider: Codex takes them from the role's `config.toml`, Claude from the profile's `disallowedTools`. OpenCode keeps the owner's config, since a config dir would drop its providers and models, and gets the limits merged on top through `OPENCODE_CONFIG_CONTENT`: `task` denied for every role, edit and bash for the Supervisor, `websearch`/`codesearch`/`webfetch` for the Peer, plus the role's denied skills and, outside the Lead, MCP servers beyond the allowlist. An Antigravity Peer runs with its role home as HOME, where Overmind writes a primary agent `overmind-peer` whose tool list leaves out web search and sub-agents and includes `generate_image`; `AGY_EXTRA_ARGS` makes agy-acp select it. Headless AGY cannot ask for permission, so that variable also passes `--dangerously-skip-permissions`. A `PreToolUse` hook in the same home denies `search_web`, `read_url_content`, `define_subagent` and `manage_subagents` as a second line. In print mode AGY can end the turn before its built-in image-generator sub-agent finishes, which is why the Peer calls `generate_image` itself.

The anomaly sensor watches Lead and Peer output; a Supervisor has no Overmind role above it to receive alerts. Every signal names a workflow anti-pattern: loss of momentum, repeated local patches, moving scope, weak verification, authority gradient, framing capture, attention dilution, or workflow hazard. Regex rules name statements that work is stuck or off course (blocked, cannot proceed, repeated failure, giving up, scope collision, explicit stop, and Vietnamese equivalents); they never match bare connectives such as "but". In the default regex + semantic mode a regex hit is only a candidate: the matched sentences are scored against the reference sentences, and only a score at or above the threshold becomes an alert. Each built-in reference belongs to an anti-pattern, so a semantic-only alert names the closest one. Weak verification is also detected structurally: a turn that claims the work is fixed, done or passing while running no test, type check, lint or build. JEV, when enabled, runs on confirmed alerts only. If the semantic model is unavailable, a regex hit still alerts and says it was not scored. Regex-only mode alerts on any rule match; semantic-only mode skips regex. Alerts are written to the source timeline and sent up one level through a turn-boundary mailbox: a Lead's alert goes to its Supervisor, a Peer's alert goes to its Lead, and a busy recipient keeps the alert queued until it is idle. An alert asks the recipient to decide whether to intervene; it never steers or stops a running agent.

## Repetition without progress

Overmind counts consecutive turns of the same agent that show the same anti-pattern; a turn without it is progress and resets the count. On the third consecutive turn the owning role (a Peer's Lead, a Lead's Supervisor) is told to change direction, with the evidence from each turn, and a stalled Peer is also reported to the Supervisor. Until a new approach is stated, the Overmind tools reject `send_agent_prompt` to that agent unless it carries `newApproach`, which is appended to the prompt and gives the anti-pattern a fresh count. The escalation is shown on the agent card and survives plugin reloads in the seat state. A Human prompt is not gated. The plugin never stops or cancels the agent itself.

Every candidate, including those the semantic check rejected, is appended to `~/.overmind/paseo-plugin/detections.jsonl` (the last 2,000 entries are kept). There is no review UI: when the owner asks, the Supervisor reads it with the read-only `sensor_log` tool (per-rule hit and confirmation counts, recent candidates, filters by agent, rule or confirmation) and recommends rule or threshold changes.

## Contract locks

Before delegating test generation, the owning Lead calls the Overmind `contract_lock`
tool with `action: "lock"`, `schemaPath` and `apiContractPath`. Both paths must name
nonempty files inside that Lead's runtime workspace directory; symlinks cannot
escape it. The plugin hashes their actual bytes and stores the lock for the Lead,
bound to its agent and workspace identities. A lock from another Lead is unusable.
The owner is still responsible for choosing the correct contract artifacts.

`action: "read"` returns the stored snapshot; `action: "unlock"` revokes it. A changed
or missing file requires a new lock. Creation, prompt admission and actual dispatch
check the current artifacts through the Overmind tools. The lock survives session
and plugin reloads in the plugin's seat state.

Recognized validation work marks its Peer `overmind.task.kind=test-generation`.
For briefs whose intent is implicit, set that label explicitly at creation.
Every later dispatch to that Peer requires the lock, including
briefs and attachments that omit test wording. Unlabelled briefs use a conservative
English/Vietnamese test-generation/TDD detector. This is not universal semantic
enforcement: implicit intentions or other languages need the explicit task label.
Running or reviewing existing checks alone on a review Peer does not require a lock.
Keep validation Peers scoped to that task; use a separate review Peer after revocation.

## Dual-seat

A Lead facing a hard decision calls `dual_seat` with the question, two directions and
optional criteria. Overmind creates one Peer per direction, each briefed only on its own
direction, so neither anchors on the other. The research Peers may read and prototype
in a temporary directory but must not change the workspace: they run in parallel on one
checkout, and the chosen direction goes to an implementing Peer afterwards. This rule is
in the brief only; the Peer sandbox stays writable. The Relay holds the first result
until every direction has reported (an archived Peer counts as reported, without a
result), then sends the Lead one report asking it to converge on a decision. The Lead
card shows `DUAL · chờ n/2` while it waits.

## Task acceptance

A completed turn becomes `READY_FOR_REVIEW`; failed or canceled work remains
`IN_PROGRESS`. The Supervisor accepts its assigned Lead's stable handback against
scope and acceptance criteria already agreed in Human brainstorming. It gathers
missing evidence or reopens unmet work within that scope without asking for
repeat Human approval. Lead and Peer cannot self-accept through the review tool;
Peer evidence returns through the Lead's handback.

The Supervisor's `overmind_task_review` Overmind tool has three actions:

- `context`: read its existing Human messages, the Lead's agreement and turn ID.
- `agreement`: record `scope`, `acceptanceCriteria` and exact `humanQuotes` from
  that conversation, including the latest Human input. Recording consolidates
  existing agreement; it does not ask the Human to confirm it again.
- `review`: bind `agreementId`, `turnId`, `evidence` and a decision. `accepted`
  requires `scope=within_agreement` and one evidence-backed check for each exact
  criterion. `reopened` sends unmet work back within the same agreement.

Only a necessary change beyond the agreement uses `decision=needs_human`,
`scope=change_required` and `requestedChange`. The task becomes
`WAITING_FOR_HUMAN`; further Lead/Peer task dispatch is blocked until the Human
responds and the Supervisor reconciles that decision into the agreement. Agent
messages and completion notifications cannot stand in for Human input. A new
Human question alone is not approval to change scope; the Supervisor must read
and honor the actual decision, and retain the original scope if a change is denied.
Scope or criteria cannot be rewritten under the same Human conversation snapshot.

Reviews and agreements survive reload and bind the Supervisor, Lead, workspace,
completed turn and prompt identity. New task input invalidates old acceptance;
new Human input must be reconciled before the next Supervisor review. The plugin
validates identity, quoted source messages and criterion coverage. Semantic
interpretation of the discussion and the quality of evidence remain the
Supervisor's responsibility; the tool does not prove those judgments correct.

The Human retains the task-card Nghiệm thu/Mở lại override with required evidence;
review cards identify Human or Supervisor and show pending scope changes.
Legacy DONE labels without evidence await review. Missing captured turn/prompt
identity requires updating the host and rerunning the task. Compact layouts omit
empty columns; schema-lock/TDD-proof chips stay hidden without corresponding proof.

Every Lead and Peer task is also written to `<project root>/.overmind/tasks.json`
at each turn boundary, review and archive. The project root is the workspace's
`projectRootPath`, so a task created in a worktree lands in the main checkout and
outlives both the agent and the worktree. The Command screen reads it for every
project Paseo lists and keeps archived tasks on the board, read-only and marked
`Đã archive · <project>`.

## Causal Notebook

The canonical key is `memory.causal_notebook`: `true` for Supervisor and `false`
for Lead/Peer. TOML uses `[memory] causal_notebook = true`; Codex config flags use
`-c memory.causal_notebook=true`; plugin environment uses that exact dotted key.
The old environment alias `MEMORY_CAUSAL_NOTEBOOK` is not read. The Supervisor
provider remains `overmind-supervisor`, independent of the selected model harness.

Supervisor receives a local `overmind_notebook` MCP server with three actions:

| Action                             | Purpose                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `causal_notebook_write`            | Record the target `workspace_id`, `session_id`, observation, structured evidence, suspected mechanism, impact, recommendation and `protocol_candidate`. `anti_pattern` supports exact type filtering. |
| `causal_notebook_read`             | Search the project of `workspace_id` by `anti_pattern` or case-insensitive `keyword`.                                                                                                                 |
| `causal_notebook_propose_protocol` | Return a candidate unified diff when at least two distinct sessions have matching mechanism and anti-pattern, with `protocol_candidate=true`.                                                         |

Each project's notebook is a versioned Markdown/JSON snapshot at
`notebooks/<sha256 of the project root>.md` in the plugin state directory, not in
the project. Lead and Peer keep file tools in the project and no tool rule stops
`cat`, so a file there would be readable and editable by them. A pre-move
`<project>/.overmind/notebook.md` is imported on first read and deleted after the
next write. Moving the project root starts a new notebook; the old file stays in
place. `workspace_id` only picks the project, so a Supervisor anywhere can write to
any project it coordinates. Writes serialize, fsync and atomically replace the
file. Malformed files fail closed and retain their contents. Nothing is uploaded by the notebook.
The `src/modules/causal_notebook.ts` and `src/actions/notebook.ts` entries re-export
the server implementations because Paseo loads runtime modules from `server/`,
`shared/` and `client/` only.

The MCP capability is bound at session-open and rechecks the live Supervisor
provider on every request. Lead/Peer receive no notebook server and their skill
deny rules include `causal_notebook_*`, even with wildcard grants. Capability
bindings and the local port survive reload in
`~/.overmind/paseo-plugin/capabilities.json`; do not share that file. Stop another
runtime using the same state directory before starting a replacement. The state
directory is the trust boundary: an agent that reads it can impersonate any seat.

The existing `OVERMIND_EVENT_ALERT` sensor event captures Tier-1/Tier-2 scores,
recent quotes, tool output and provider-published reasoning summaries. It uses
the source agent's actual Supervisor ancestry, including another project. Paseo's
`agent.turn_ended` hook supplies the turn-boundary capture; there is no native
`onTurnBoundary` EventBus hook. Sensor entries start as unconfirmed hypotheses,
with `protocol_candidate=false`. A later boundary refresh preserves Supervisor
analysis and protocol decisions for the same alert. The Supervisor promotes a reviewed
entry by writing it again with the same `alert_id`, its mechanism and
`protocol_candidate=true`; only promoted entries count toward a proposal.
Repetition (`structural`) alerts carry `tier: null`, since neither sensor tier fired.

The Overmind Command screen has a read-only notebook list for every project, so
the owner can review entries without running a Supervisor session or any live seat. It reads the same file the MCP actions write, bypassing the Supervisor
check: that check keeps Lead and Peer agents out, not the person running the
daemon. Reviewing or applying a protocol proposal stays an MCP action.

Protocol proposals include source entry UUIDs and a SHA-256 of the original
`WORKSPACE_PROTOCOL.md`. They are returned for owner review and never applied
automatically. Reload the plugin, then recreate/reload Supervisor sessions to
receive the tools; existing notebook files remain available across session resets.

The default semantic model is all-MiniLM-L6-v2 int8 on the host CPU. On first startup the plugin downloads its pinned model files from Hugging Face and verifies an embedding before reporting ready. Model weights are about 23 MB; the ONNX runtime and other dependencies use additional disk space. Files are cached under the user's `.cache/overmind-models` directory and retained across plugin updates. This small model is intended primarily for English output. Alternatively, use Ollama, list models installed on the host, select one and test embedding support.

JEV is a TypeSafe structured evaluator, separate from coding providers. Test verifies the API key and evaluates a synthetic sample. Automatic JEV review is off by default. Enabling it sends the latest objective, bounded agent output and detected signals to `api.typesafe.ai` when a candidate alert is found. Confidence and choice probability have independent thresholds. API keys stay in host-scoped plugin settings and are masked in the form.

Requires Paseo 0.13.2 or newer with plugins enabled. Plugins run as trusted code on the host. The plugin uses the provider accounts already configured in Paseo.
