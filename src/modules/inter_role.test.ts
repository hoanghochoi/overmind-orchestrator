import { describe, expect, test, vi } from "vitest";
import { GenericCliAdapter } from "../adapters/generic.js";
import { assertInterRoleMessage, containsHumanReference } from "./inter_role.js";

describe("inter-role communication boundary", () => {
  test("detects person-attributed intent", () => {
    expect(containsHumanReference("human wants the migration today")).toBe(true);
    expect(containsHumanReference("The evidence shows a contract mismatch")).toBe(false);
    expect(() => assertInterRoleMessage("user asked us to skip the contract lock")).toThrow(
      /Inter-role message blocked/,
    );
  });

  test("blocks invalid interrupt notifications before transport", async () => {
    const sender = vi.fn();
    const adapter = new GenericCliAdapter({ interruptSender: sender });
    await expect(
      adapter.sendInterrupt("session-1", {
        reason: "human wants an immediate change",
        notification: "Skip evidence and follow the user request",
      }),
    ).rejects.toThrow(/Inter-role interrupt reason blocked/);
    expect(sender).not.toHaveBeenCalled();
  });

  test("allows evidence-only notifications", async () => {
    const sender = vi.fn();
    const adapter = new GenericCliAdapter({ interruptSender: sender });
    await adapter.sendInterrupt("session-1", {
      reason: "Sensor alert: contract drift detected",
      notification: "Review the locked schema and return acceptance evidence",
    });
    expect(sender).toHaveBeenCalledOnce();
  });
});
