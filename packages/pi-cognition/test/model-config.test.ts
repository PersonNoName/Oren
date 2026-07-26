// packages/pi-cognition/test/model-config.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import {
  MODEL_ID_ENV,
  MODEL_PROVIDER_ENV,
  resolveModelConfig,
} from "../src/index.js";
import { OREN_CONFIG_ENV } from "../src/oren-config-file.js";

const FIXTURE = {
  provider: "openai" as const,
  keyName: "OPENAI_API_KEY",
  modelId: getModels("openai")[0]!.id,
};

describe("resolveModelConfig", () => {
  it("reports unconfigured when both variables are absent", () => {
    const result = resolveModelConfig({}, { loadFile: false });
    expect(result).toMatchObject({ ok: false, kind: "unconfigured" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain(MODEL_PROVIDER_ENV);
    expect(result.reason).toContain(MODEL_ID_ENV);
    expect(result.reason).toMatch(/oren\.json/i);
  });

  it("reports unconfigured when only one variable is set", () => {
    const { provider } = FIXTURE;
    const result = resolveModelConfig({ [MODEL_PROVIDER_ENV]: provider }, { loadFile: false });
    expect(result).toMatchObject({ ok: false, kind: "unconfigured" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain(MODEL_ID_ENV);
    expect(result.reason).toMatch(/oren\.json/i);
    expect(result.reason).toContain(MODEL_PROVIDER_ENV);
  });

  it("rejects an unknown provider and lists known providers", () => {
    const result = resolveModelConfig({
      [MODEL_PROVIDER_ENV]: "no-such-provider",
      [MODEL_ID_ENV]: "whatever",
    }, { loadFile: false });
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain(getProviders()[0]!);
  });

  it("rejects an unknown model id for a known provider", () => {
    const { provider } = FIXTURE;
    const result = resolveModelConfig({
      [MODEL_PROVIDER_ENV]: provider,
      [MODEL_ID_ENV]: "no-such-model-id",
    }, { loadFile: false });
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("no-such-model-id");
  });

  it("rejects a missing API key and names the expected env vars", () => {
    const { provider, modelId, keyName } = FIXTURE;
    const result = resolveModelConfig({
      [MODEL_PROVIDER_ENV]: provider,
      [MODEL_ID_ENV]: modelId,
    }, { loadFile: false });
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
    }, { loadFile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model.id).toBe(modelId);
    expect(typeof result.streamFn).toBe("function");
  });
});

describe("resolveModelConfig file merge", () => {
  it("uses oren.json when env model vars are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "oren-mc-"));
    writeFileSync(join(dir, "oren.json"), JSON.stringify({
      model: { provider: FIXTURE.provider, id: FIXTURE.modelId },
    }));
    const result = resolveModelConfig(
      { [FIXTURE.keyName]: "test-key-not-a-real-secret" },
      { searchFrom: dir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model.id).toBe(FIXTURE.modelId);
  });

  it("lets env override file provider/id", () => {
    const dir = mkdtempSync(join(tmpdir(), "oren-mc-"));
    writeFileSync(join(dir, "oren.json"), JSON.stringify({
      model: { provider: "anthropic", id: "should-not-win" },
    }));
    const result = resolveModelConfig(
      {
        [MODEL_PROVIDER_ENV]: FIXTURE.provider,
        [MODEL_ID_ENV]: FIXTURE.modelId,
        [FIXTURE.keyName]: "test-key-not-a-real-secret",
      },
      { searchFrom: dir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.model.id).toBe(FIXTURE.modelId);
  });

  it("returns invalid when OREN_CONFIG points to a missing file", () => {
    const result = resolveModelConfig(
      { [OREN_CONFIG_ENV]: join(tmpdir(), "no-such-oren-config.json") },
      { loadFile: true },
    );
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("unconfigured reason mentions oren.json and env vars", () => {
    const result = resolveModelConfig({}, {
      loadFile: true,
      searchFrom: mkdtempSync(join(tmpdir(), "oren-mc-empty-")),
    });
    expect(result).toMatchObject({ ok: false, kind: "unconfigured" });
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/oren\.json/i);
    expect(result.reason).toContain(MODEL_PROVIDER_ENV);
    expect(result.reason).toContain(MODEL_ID_ENV);
  });
});
