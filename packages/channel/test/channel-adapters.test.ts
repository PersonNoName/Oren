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
  it("publishes ordered speech events and retains a completed utterance", async () => {
    const port = new PanelInboxAdapter(() => "2026-07-26T12:00:00.000Z");
    const observed: unknown[] = [];
    const unsubscribe = port.subscribeSpeech((event) => observed.push(event));

    await port.startSpeech({ episodeId: "e1", messageId: "m1" });
    await port.appendSpeech({ messageId: "m1", text: "你" });
    await port.appendSpeech({ messageId: "m1", text: "好" });
    await port.completeSpeech({ messageId: "m1", status: "complete" });

    expect(observed).toEqual([
      { type: "speech.started", episodeId: "e1", messageId: "m1" },
      { type: "speech.delta", messageId: "m1", text: "你" },
      { type: "speech.delta", messageId: "m1", text: "好" },
      { type: "speech.completed", messageId: "m1", status: "complete" },
    ]);
    expect(port.liveMessages.get("m1")).toEqual({
      episodeId: "e1",
      messageId: "m1",
      text: "你好",
      status: "complete",
    });
    unsubscribe();
  });

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

  it("is idempotent by deliveryId", async () => {
    const port = new PanelInboxAdapter(() => "2026-07-26T12:00:00.000Z");
    const input = {
      deliveryId: "d1",
      text: "hi",
      reason: "share",
      proactive: true,
    };
    const first = await port.deliver(input);
    const second = await port.deliver({ ...input, text: "duplicate attempt" });
    expect(second).toEqual(first);
    expect(port.messages).toHaveLength(1);
    expect(port.messages[0]?.text).toBe("hi");
  });
});
