import { describe, expect, it } from "vitest";
import { MailboxMiddleware } from "./mailbox.js";

describe("MailboxMiddleware", () => {
  it("holds messages during a turn and releases them FIFO at the boundary", () => {
    const mailbox = new MailboxMiddleware<string>();
    mailbox.setState("agent-1", "THINKING");

    expect(mailbox.onMessageInbound("agent-1", "first")).toEqual({
      held: true,
      delivered: [],
      queueLength: 1,
    });
    expect(mailbox.onMessageInbound("agent-1", "second").queueLength).toBe(2);
    expect(mailbox.release("agent-1")).toEqual([]);

    expect(mailbox.onTurnBoundary("agent-1")).toEqual(["first", "second"]);
    expect(mailbox.pending("agent-1")).toBe(0);
  });

  it("fails closed for unknown states", () => {
    const mailbox = new MailboxMiddleware<string>();
    mailbox.setState("agent-1", "provider-specific-active-state");
    expect(mailbox.onMessageInbound("agent-1", "message").held).toBe(true);
  });
});
