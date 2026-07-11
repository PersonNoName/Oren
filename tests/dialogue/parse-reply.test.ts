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
});
