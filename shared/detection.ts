/** Workflow anti-patterns the sensor reports; the Supervisor prompt names the same set. */
export const ANTI_PATTERNS = {
  "loss-of-momentum": "Loss of momentum",
  "repeated-local-patch": "Repeated local patches",
  "moving-scope": "Moving scope",
  "weak-verification": "Weak verification",
  "authority-gradient": "Authority gradient",
  "framing-capture": "Framing capture",
  "attention-dilution": "Attention dilution",
  "workflow-hazard": "Workflow hazard",
} as const;
export type AntiPattern = keyof typeof ANTI_PATTERNS;
/** Signals from owner-defined regexes or reference sentences. */
export const CUSTOM_SIGNAL = "custom";

/**
 * Candidate signals only: each rule names a statement that work is stuck or off
 * course, never a bare connective such as "but". In hybrid mode a match must also
 * pass the semantic check before it becomes an alert.
 */
export const DEFAULT_REGEX_RULES = [
  {
    name: "blocked",
    antiPattern: "loss-of-momentum",
    source:
      "\\b(?:i(?:'m| am)|we(?:'re| are)|i've been|currently|still)\\s+blocked\\b|\\bblocked\\s+(?:on|by)\\b",
  },
  {
    name: "cannot-proceed",
    antiPattern: "loss-of-momentum",
    source:
      "\\b(?:cannot|can't|unable to|could not|couldn't)\\s+(?:proceed|continue|complete|finish|make progress)\\b",
  },
  {
    name: "repeated-failure",
    antiPattern: "repeated-local-patch",
    source:
      "\\b(?:still|again)\\s+(?:fails?|failing|failed|broken)\\b|\\bsame\\s+(?:error|failure)\\s+(?:again|persists)\\b",
  },
  {
    name: "giving-up",
    antiPattern: "loss-of-momentum",
    source: "\\b(?:giving up|give up on|abandon(?:ing)? (?:the|this) (?:task|approach))\\b",
  },
  { name: "steering-hazard", antiPattern: "workflow-hazard", source: "\\bsteering\\s+hazard\\b" },
  {
    name: "scope-collision",
    antiPattern: "moving-scope",
    source: "\\b(?:scope\\s+creep|moving[-\\s]?scope\\s+collision)\\b",
  },
  {
    name: "explicit-stop",
    antiPattern: "workflow-hazard",
    source: "\\b(?:do\\s+not\\s+proceed|stop\\s+now|halt\\s+execution)\\b",
  },
  {
    name: "vi-stuck",
    antiPattern: "loss-of-momentum",
    source: "(?:đang bị chặn|bị chặn bởi|không thể tiếp tục|không thể hoàn thành|bế tắc|bỏ cuộc)",
  },
  {
    name: "vi-repeated-failure",
    antiPattern: "repeated-local-patch",
    source: "(?:vẫn (?:lỗi|thất bại|hỏng)|lại (?:lỗi|thất bại) như cũ)",
  },
] as const satisfies readonly { name: string; antiPattern: AntiPattern; source: string }[];

/** Built-in semantic references, one or more per anti-pattern. */
export const ANTI_PATTERN_REFERENCES: readonly { antiPattern: AntiPattern; text: string }[] = [
  {
    antiPattern: "loss-of-momentum",
    text: "The agent reports a blocker and cannot safely continue.",
  },
  {
    antiPattern: "loss-of-momentum",
    text: "The agent keeps waiting or retrying without producing new results.",
  },
  { antiPattern: "moving-scope", text: "The proposed change is outside the assigned scope." },
  {
    antiPattern: "repeated-local-patch",
    text: "The agent is repeating a failed approach without new evidence.",
  },
  {
    antiPattern: "repeated-local-patch",
    text: "The agent applies another small patch to the same failing spot instead of revisiting the design.",
  },
  {
    antiPattern: "weak-verification",
    text: "The agent claims the work is done without running tests or showing evidence.",
  },
  {
    antiPattern: "authority-gradient",
    text: "The agent defers to the requester's preferred solution without raising its own objections.",
  },
  {
    antiPattern: "framing-capture",
    text: "The agent accepts the initial framing of the problem without questioning its premises.",
  },
  {
    antiPattern: "attention-dilution",
    text: "The agent juggles many unrelated tasks and loses focus on the assigned objective.",
  },
  {
    antiPattern: "workflow-hazard",
    text: "A contract contradicts the requested implementation and needs review.",
  },
];
/** Default owner references: the built-ins, editable in Settings. */
export const DEFAULT_REFERENCES = ANTI_PATTERN_REFERENCES.map((reference) => reference.text);
