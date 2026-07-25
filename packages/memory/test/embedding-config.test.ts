import { describe, expect, it } from "vitest";
import {
  EMBEDDING_MODEL_ENV,
  EMBEDDING_PROVIDER_ENV,
  resolveEmbeddingConfig,
} from "@oren/memory";

describe("resolveEmbeddingConfig", () => {
  it("reports unconfigured when provider/model are missing", () => {
    const result = resolveEmbeddingConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("unconfigured");
      expect(result.reason).toContain(EMBEDDING_PROVIDER_ENV);
      expect(result.reason).toContain(EMBEDDING_MODEL_ENV);
    }
  });

  it("rejects unknown providers", () => {
    const result = resolveEmbeddingConfig({
      [EMBEDDING_PROVIDER_ENV]: "nope",
      [EMBEDDING_MODEL_ENV]: "m",
    });
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("requires the provider API key with an actionable message", () => {
    const result = resolveEmbeddingConfig({
      [EMBEDDING_PROVIDER_ENV]: "openai",
      [EMBEDDING_MODEL_ENV]: "text-embedding-3-small",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid");
      expect(result.reason).toContain("OPENAI_API_KEY");
    }
  });

  it("returns an embedder when fully configured (no network call)", () => {
    const result = resolveEmbeddingConfig({
      [EMBEDDING_PROVIDER_ENV]: "openai",
      [EMBEDDING_MODEL_ENV]: "text-embedding-3-small",
      OPENAI_API_KEY: "sk-test",
    });
    expect(result.ok).toBe(true);
  });
});
