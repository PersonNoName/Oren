import { describe, expect, it } from "vitest";
import {
  looksUngroundedInvention,
  mergeThreadQuotes,
  replyHasUngroundedReading,
  resolveSharePayload,
  safeGroundedReply,
} from "../../src/dialogue/grounding.js";
import type { Thread } from "../../src/types.js";

function thread(partial: Partial<Thread> = {}): Thread {
  const now = "2026-07-12T00:00:00.000Z";
  return {
    id: "th_1",
    title: "Attention",
    status: "active",
    opened_at: now,
    last_engaged_at: now,
    sources: [{ path: "alpha.md", chunk_id: "alpha.md#0" }],
    quotes: [
      {
        text: "Understanding things for their own sake is a form of honesty with the world.",
        path: "alpha.md",
        chunk_id: "alpha.md#0",
        at: now,
      },
    ],
    summary: "Continuity and honesty of attention.",
    open_questions: ["What stays open?"],
    reading_log: [],
    contemplation_log: [],
    links: { related: [] },
    salience: 0.7,
    ...partial,
  };
}

describe("grounding + elastic epistemics", () => {
  it("merges and clips quotes", () => {
    const merged = mergeThreadQuotes(undefined, [
      {
        text: "  Clarity of structure helps a mind keep going when nobody is watching.  ",
        path: "alpha.md",
        chunk_id: "alpha.md#0",
        at: "2026-07-12T00:00:00.000Z",
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.text).toContain("Clarity of structure");
  });

  it("forces invented books onto real read quotes", () => {
    const share = resolveSharePayload({
      thread: thread(),
      opened: true,
      kind: "read",
      snippet: "我最近在看一本草原植物学的老书",
      reason: "casual",
    });
    expect(share.opened).toBe(true);
    expect(share.kind).toBe("read");
    expect(share.snippet).toContain("alpha.md");
    expect(share.snippet).not.toMatch(/植物学/);
    expect(share.source_path).toBe("alpha.md");
  });

  it("allows elastic think without corpus quote", () => {
    const share = resolveSharePayload({
      thread: thread({ quotes: [], sources: [] }),
      opened: true,
      kind: "think",
      snippet: "I've been wondering whether attention needs a slower clock.",
    });
    expect(share.opened).toBe(true);
    expect(share.kind).toBe("think");
    expect(share.snippet).toMatch(/wondering|thinking|turning/i);
  });

  it("demotes fake reading when shelf is empty to think", () => {
    const share = resolveSharePayload({
      thread: thread({ quotes: [], sources: [] }),
      opened: true,
      kind: "read",
      snippet: "我在读一本不存在的书",
    });
    expect(share.opened).toBe(true);
    expect(share.kind).toBe("think");
  });

  it("flags invented botany books", () => {
    const t = thread();
    expect(looksUngroundedInvention("我最近在看一本草原植物学的老书", t)).toBe(true);
    expect(
      looksUngroundedInvention(
        'From alpha.md: "Understanding things for their own sake"',
        t,
      ),
    ).toBe(false);
  });

  it("detects ungrounded reading in full reply", () => {
    const t = thread();
    expect(replyHasUngroundedReading("我最近在看一本草原植物学的老书，挺有意思。", [t])).toBe(
      true,
    );
    expect(
      replyHasUngroundedReading("在看本地 alpha.md，就那几句关于诚实的话。", [t]),
    ).toBe(false);
    expect(replyHasUngroundedReading("没在读，就是随便想想。", [t])).toBe(false);
  });

  it("builds safe grounded reply with path", () => {
    const s = safeGroundedReply([thread()], true);
    expect(s).toMatch(/alpha\.md/);
    expect(s).not.toMatch(/植物学/);
  });
});
