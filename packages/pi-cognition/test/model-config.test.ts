// packages/pi-cognition/test/model-config.test.ts
import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import {
  MODEL_ID_ENV,
  MODEL_PROVIDER_ENV,
  resolveModelConfig,
} from "../src/index.js";

const FIXTURE = {
  provider: "openai" as const,
  keyName: "OPENAI_API_KEY",
  modelId: getModels("openai")[0]!.id,
};

describe("resolveModelConfig", () => {
  it("reports unconfigured when both variables are absent", () => {
    const result = resolveModelConfig({});
    expect(result).toMatchObject({ ok: false, kind: "unconfigured" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain(MODEL_PROVIDER_ENV);
    expect(result.reason).toContain(MODEL_ID_ENV);
  });

  it("reports unconfigured when only one variable is set", () => {
    const { provider } = FIXTURE;
    const result = resolveModelConfig({ [MODEL_PROVIDER_ENV]: provider });
    expect(result).toMatchObject({ ok: false, kind: "unconfigured" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain(MODEL_ID_ENV);
  });

  it("rejects an unknown provider and lists known providers", () => {
    const result = resolveModelConfig({
      [MODEL_PROVIDER_ENV]: "no-such-provider",
      [MODEL_ID_ENV]: "whatever",
    });
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain(getProviders()[0]!);
  });

  it("rejects an unknown model id for a known provider", () => {
    const { provider } = FIXTURE;
    const result = resolveModelConfig({
      [MODEL_PROVIDER_ENV]: provider,
      [MODEL_ID_ENV]: "no-such-model-id",
    });
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("no-such-model-id");
  });

  it("rejects a missing API key and names the expected env vars", () => {
    const { provider, modelId, keyName } = FIXTURE;
    const result = resolveModelConfig({
      [MODEL_PROVIDER_ENV]: provider,
      [MODEL_ID_ENV]: modelId,
    });
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain(keyName);
    expect(result.reason).not.toContain("sk-");
  });

  it("resolves a model and streamFn when config and key are present", () => {
    const { provider, modelId, keyName } = FIXTURE;
    const result = resolveModelConfig({
      [MODEL_PROVIDER_ENV]: provider,
      [MODEL_ID_ENV]: modelId,
      [keyName]: "test-key-not-a-real-secret",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model.id).toBe(modelId);
    expect(typeof result.streamFn).toBe("function");
  });
});
