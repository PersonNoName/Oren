import { describe, expect, it } from "vitest";
import { DialogueParseError, parseDialogueReply } from "../../src/dialogue/parse-reply.js";

describe("parseDialogueReply", () => {
  it("parses fenced json", () => {
    const a = parseDialogueReply(
      '```json\n{"reply":"hi","share":{"opened":false}}\n```',
    );
    expect(a.reply).toBe("hi");
    expect(a.share.opened).toBe(false);
  });

  it("rejects empty reply", () => {
    expect(() => parseDialogueReply('{"reply":"  ","share":{"opened":false}}')).toThrow(
      DialogueParseError,
    );
  });

  it("parses share kind and source_path", () => {
    const a = parseDialogueReply(
      JSON.stringify({
        reply: "look",
        share: {
          opened: true,
          kind: "read",
          thread_id: "th_1",
          snippet: "from alpha",
          source_path: "alpha.md",
        },
        reception: "warm",
      }),
    );
    expect(a.share.kind).toBe("read");
    expect(a.share.source_path).toBe("alpha.md");
    expect(a.utterances).toEqual(["look"]);
    expect(a.stance).toBe("follow");
  });

  it("parses multi-bubble utterances and stance", () => {
    const a = parseDialogueReply(
      JSON.stringify({
        utterances: ["先接住你这句。", "我这边还在想注意力那条线。", "你要是累了就先忙。"],
        stance: "weave",
        share: { opened: false },
        reception: "warm",
      }),
    );
    expect(a.utterances).toHaveLength(3);
    expect(a.reply).toBe("先接住你这句。");
    expect(a.stance).toBe("weave");
  });

  it("caps utterances at 4", () => {
    const a = parseDialogueReply(
      JSON.stringify({
        utterances: ["1", "2", "3", "4", "5", "6"],
        share: { opened: false },
      }),
    );
    expect(a.utterances).toHaveLength(4);
  });
});
