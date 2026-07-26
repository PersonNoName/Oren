import { describe, expect, it } from "vitest";
import { PanelInboxAdapter, ScriptedChannelAdapter } from "@oren/channel";

describe("ScriptedChannelAdapter", () => {
  it("records calls and returns scripted failure", async () => {
    const port = new ScriptedChannelAdapter({
      deliver: () => ({ ok: false, code: "boom", message: "nope" }),
    });
    const r = await port.deliver({
      deliveryId: "d1",
      text: "hi",
      reason: "share",
      proactive: true,
    });
    expect(r.ok).toBe(false);
    expect(port.calls).toHaveLength(1);
  });
});

describe("PanelInboxAdapter", () => {
  it("stores messages with deliveredAt", async () => {
    const port = new PanelInboxAdapter(() => "2026-07-26T12:00:00.000Z");
    const r = await port.deliver({
      deliveryId: "d1",
      text: "hi",
      reason: "share",
      proactive: false,
    });
    expect(r).toEqual({ ok: true, deliveredAt: "2026-07-26T12:00:00.000Z" });
    expect(port.messages[0]?.deliveryId).toBe("d1");
  });
});
