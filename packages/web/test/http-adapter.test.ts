import { describe, expect, it } from "vitest";
import { extractReadableText } from "@oren/web";

describe("extractReadableText", () => {
  it("keeps visible text and strips script content", () => {
    const text = extractReadableText("<html><script>x</script><p>你好</p></html>");
    expect(text).toContain("你好");
    expect(text).not.toContain("x");
  });
});
