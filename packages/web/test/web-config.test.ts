import { describe, expect, it } from "vitest";
import {
  TAVILY_API_KEY_ENV,
  WEB_SEARCH_PROVIDER_ENV,
  resolveWebConfig,
} from "@oren/web";

describe("resolveWebConfig", () => {
  it("reports unconfigured when provider and API key are missing", () => {
    const result = resolveWebConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("unconfigured");
      expect(result.reason).toContain(WEB_SEARCH_PROVIDER_ENV);
      expect(result.reason).toContain(TAVILY_API_KEY_ENV);
    }
  });

  it("rejects tavily without an API key", () => {
    const result = resolveWebConfig({
      [WEB_SEARCH_PROVIDER_ENV]: "tavily",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid");
      expect(result.reason).toContain(TAVILY_API_KEY_ENV);
    }
  });

  it("rejects whitespace-only API keys", () => {
    const result = resolveWebConfig({
      [WEB_SEARCH_PROVIDER_ENV]: "tavily",
      [TAVILY_API_KEY_ENV]: "   ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid");
      expect(result.reason).toContain(TAVILY_API_KEY_ENV);
    }
  });

  it("returns an adapter when fully configured without network calls", () => {
    const result = resolveWebConfig({
      [WEB_SEARCH_PROVIDER_ENV]: "tavily",
      [TAVILY_API_KEY_ENV]: "tvly-test",
    });
    expect(result.ok).toBe(true);
  });
});
