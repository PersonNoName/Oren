import { describe, expect, it } from "vitest";
import { ScriptedWebAdapter } from "@oren/web";

describe("ScriptedWebAdapter", () => {
  it("clamps search limit above 5 to 5", async () => {
    let receivedLimit = 0;
    const adapter = new ScriptedWebAdapter({
      search: (_query, limit) => {
        receivedLimit = limit;
        return { results: [] };
      },
      read: () => ({ url: "https://example.com", text: "ok" }),
    });

    await adapter.search({ query: "test", limit: 10 });

    expect(receivedLimit).toBe(5);
  });

  it("truncates read text to 8192 characters", async () => {
    const longText = "x".repeat(10_000);
    const adapter = new ScriptedWebAdapter({
      search: () => ({ results: [] }),
      read: () => ({ url: "https://example.com", text: longText }),
    });

    const result = await adapter.read({ url: "https://example.com" });

    expect(result.text).toHaveLength(8192);
    expect(result.text).toBe(longText.slice(0, 8192));
  });

  it("throws when read URL is unsafe", async () => {
    const adapter = new ScriptedWebAdapter({
      search: () => ({ results: [] }),
      read: () => ({ url: "http://127.0.0.1/", text: "secret" }),
    });

    await expect(adapter.read({ url: "http://127.0.0.1/" })).rejects.toThrow(
      expect.objectContaining({ message: expect.stringMatching(/.+/) }),
    );
  });
});
