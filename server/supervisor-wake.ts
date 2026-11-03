import { execCommand } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const supervisorWakeInput = z
  .object({
    cron: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[0-9*,/ -]+$/),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_+/:-]+$/)
      .optional(),
  })
  .strict();

const wakeResult = z.object({
  id: z.string().min(1),
  status: z.literal("active"),
  nextRunAt: z.string().min(1),
});
const WAKE_PROMPT =
  "Overmind Supervisor wake: review pending governance work for your existing assigned Leads. Continue within the Human's agreed scope and report verified evidence. Do not create a new Lead or change provider/model for this wake. If nothing is actionable, end your turn and stay idle.";

/** The plugin SDK has no scheduler API; use the host CLI's agent-bound heartbeat. */
export async function createSupervisorWake(
  callerId: string,
  input: z.infer<typeof supervisorWakeInput>,
) {
  const args = [
    "heartbeat",
    "create",
    "--home",
    process.env.PASEO_HOME || join(homedir(), ".paseo"),
    "--cron",
    input.cron,
    "--max-runs",
    "1",
    "--json",
  ];
  if (input.timezone) args.push("--timezone", input.timezone);
  args.push("--", WAKE_PROMPT);
  // Only restricted cron/timezone tokens reach argv; the target is the bound MCP caller.
  const { stdout } = await execCommand(process.env.PASEO_CLI || "paseo", args, {
    env: { ...process.env, PASEO_AGENT_ID: callerId },
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  return {
    ...wakeResult.parse(JSON.parse(stdout)),
    target: { type: "agent" as const, agentId: callerId },
    maxRuns: 1,
  };
}
