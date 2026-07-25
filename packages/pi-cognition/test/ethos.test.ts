// packages/pi-cognition/test/ethos.test.ts
import { describe, expect, it } from "vitest";
import { getEthos } from "../src/index.js";

describe("getEthos", () => {
  it("returns the v1 ethos covering all four dimensions", () => {
    const ethos = getEthos(1);
    expect(ethos).toContain("世界与价值");
    expect(ethos).toContain("认知脾气");
    expect(ethos).toContain("关系观");
    expect(ethos).toContain("感性");
    expect(ethos.length).toBeGreaterThan(200);
  });

  it("rejects unknown versions explicitly", () => {
    expect(() => getEthos(2)).toThrow(/Unknown ethos version: 2/);
    expect(() => getEthos(0)).toThrow(/Unknown ethos version: 0/);
  });
});
