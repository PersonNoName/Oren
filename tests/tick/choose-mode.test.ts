import { describe, expect, it } from "vitest";
import { chooseMode } from "../../src/tick/choose-mode.js";
import { defaultConfig } from "../../src/types.js";

describe("chooseMode", () => {
  it("force wins", () => {
    const r = chooseMode({
      force: "idle",
      recentModes: ["contemplate", "contemplate"],
      config: defaultConfig(),
      hasReadableCorpus: true,
      activeThreadCount: 0,
      rng: () => 0.99,
    });
    expect(r.mode).toBe("idle");
  });

  it("max consecutive contemplate switches away", () => {
    const config = defaultConfig();
    config.mode.max_consecutive_contemplate = 2;
    config.mode.idle_probability = 0;
    const r = chooseMode({
      recentModes: ["contemplate", "contemplate"],
      config,
      hasReadableCorpus: true,
      activeThreadCount: 0,
      rng: () => 0.99,
    });
    expect(r.mode).toBe("organize");
  });

  it("idle probability", () => {
    const config = defaultConfig();
    config.mode.idle_probability = 0.5;
    const r = chooseMode({
      recentModes: [],
      config,
      hasReadableCorpus: true,
      activeThreadCount: 0,
      rng: () => 0.1,
    });
    expect(r.mode).toBe("idle");
  });
});
