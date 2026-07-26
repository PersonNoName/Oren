import { describe, expect, it } from "vitest";
import { extractReadableText, HttpWebAdapter } from "@oren/web";

describe("extractReadableText", () => {
  it("keeps visible text and strips script content", () => {
    const text = extractReadableText("<html><script>x</script><p>你好</p></html>");
    expect(text).toContain("你好");
    expect(text).not.toContain("x");
  });
});

describe("HttpWebAdapter.read", () => {
  it("rejects redirects to private hosts", async () => {
    const adapter = new HttpWebAdapter({
      apiKey: "test-key",
      fetchFn: async (input) => {
        const url = String(input);
        if (url === "https://example.com/public") {
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/secret" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    await expect(adapter.read({ url: "https://example.com/public" }))
      .rejects.toThrow(/not allowed|private|local/i);
  });

  it("rejects when final response URL is unsafe", async () => {
    const adapter = new HttpWebAdapter({
      apiKey: "test-key",
      fetchFn: async () => {
        const response = new Response("<p>secret</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
        Object.defineProperty(response, "url", {
          value: "http://192.168.0.1/internal",
        });
        return response;
      },
    });

    await expect(adapter.read({ url: "https://example.com/public" }))
      .rejects.toThrow(/not allowed|private|local/i);
  });

  it("follows safe redirects and returns final URL", async () => {
    const adapter = new HttpWebAdapter({
      apiKey: "test-key",
      fetchFn: async (input) => {
        const url = String(input);
        if (url === "https://example.com/public") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://example.com/final" },
          });
        }
        if (url === "https://example.com/final") {
          return new Response("<p>safe content</p>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    const result = await adapter.read({ url: "https://example.com/public" });
    expect(result.url).toBe("https://example.com/final");
    expect(result.text).toContain("safe content");
  });
});
