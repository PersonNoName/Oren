import { describe, expect, it } from "vitest";
import { assertSafeHttpUrl } from "@oren/web";

describe("assertSafeHttpUrl", () => {
  it("allows public https URLs", () => {
    const result = assertSafeHttpUrl("https://example.com/x");
    expect(result).toEqual({ ok: true, href: "https://example.com/x" });
  });

  it.each([
    "https://fc00.com/",
    "https://fd00.com/",
    "https://fe80.com/",
  ])("allows DNS hostname that resembles IPv6 prefix %s", (raw) => {
    const result = assertSafeHttpUrl(raw);
    expect(result).toEqual({ ok: true, href: raw });
  });

  it.each([
    "http://127.0.0.1/",
    "http://192.168.0.1/",
    "http://10.0.0.2/",
    "http://172.16.1.1/",
    "http://0.0.0.0/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:c0a8:1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456:789a:1::1]/",
    "http://[fe80::1]/",
    "http://[fe80::dead:beef]/",
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
