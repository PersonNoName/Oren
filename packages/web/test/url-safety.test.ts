import { describe, expect, it } from "vitest";
import { assertSafeHttpUrl } from "@oren/web";

describe("assertSafeHttpUrl", () => {
  it("allows public https URLs", () => {
    const result = assertSafeHttpUrl("https://example.com/x");
    expect(result).toEqual({ ok: true, href: "https://example.com/x" });
  });

  it.each([
    "http://127.0.0.1/",
    "http://192.168.0.1/",
    "http://10.0.0.2/",
    "http://172.16.1.1/",
    "file:///etc/passwd",
    "ftp://x",
    "http://localhost/",
  ])("rejects unsafe URL %s", (raw) => {
    const result = assertSafeHttpUrl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBeTruthy();
    }
  });
});
