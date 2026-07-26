import { describe, expect, it } from "vitest";
import { buildChatMessages } from "../src/lib/chat-messages.js";

describe("buildChatMessages", () => {
  it("merges user locals and delivered inbox sorted by at", () => {
    const messages = buildChatMessages(
      [
        {
          deliveryId: "d1",
          text: "hi back",
          reason: "share",
          status: "delivered",
          at: "2026-07-26T12:00:02.000Z",
        },
      ],
      [{ id: "u1", text: "hello", at: "2026-07-26T12:00:01.000Z" }],
    );
    expect(messages.map((m) => m.kind)).toEqual(["user", "oren"]);
    expect(messages[0]?.text).toBe("hello");
    expect(messages[1]?.text).toBe("hi back");
  });

  it("marks deferred/failed as oren-weak", () => {
    const messages = buildChatMessages(
      [
        {
          deliveryId: "d2",
          text: "later",
          reason: "quiet",
          status: "deferred",
          at: "2026-07-26T12:00:03.000Z",
          deferUntil: "2026-07-26T20:00:00.000Z",
        },
      ],
      [],
    );
    expect(messages).toEqual([
      {
        kind: "oren-weak",
        id: "d2",
        text: "later",
        at: "2026-07-26T12:00:03.000Z",
        status: "deferred",
        deliveryId: "d2",
      },
    ]);
  });
});
