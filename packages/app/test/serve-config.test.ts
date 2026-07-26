import { describe, expect, it } from "vitest";
import { resolveServeConfig } from "../src/serve-config.js";

describe("resolveServeConfig", () => {
  it("uses defaults when env empty", () => {
    const config = resolveServeConfig({}, () => "/home/me");
    expect(config).toEqual({
      databasePath: "/home/me/.oren/life.db",
      panelPort: 7465,
      orenId: "oren-local",
      personId: "person-local",
      drainIntervalMs: 2000,
    });
  });

  it("honors overrides", () => {
    const config = resolveServeConfig({
      OREN_DB: "/tmp/custom.db",
      OREN_PANEL_PORT: "9001",
      OREN_ID: "oren-x",
      OREN_PERSON_ID: "person-x",
      OREN_DRAIN_INTERVAL_MS: "500",
    }, () => "/home/me");
    expect(config.databasePath).toBe("/tmp/custom.db");
    expect(config.panelPort).toBe(9001);
    expect(config.orenId).toBe("oren-x");
    expect(config.personId).toBe("person-x");
    expect(config.drainIntervalMs).toBe(500);
  });

  it("rejects invalid panel port", () => {
    expect(() => resolveServeConfig({ OREN_PANEL_PORT: "0" }, () => "/h")).toThrow(/OREN_PANEL_PORT/);
    expect(() => resolveServeConfig({ OREN_PANEL_PORT: "abc" }, () => "/h")).toThrow(/OREN_PANEL_PORT/);
  });

  it("rejects invalid drain interval", () => {
    expect(() => resolveServeConfig({ OREN_DRAIN_INTERVAL_MS: "0" }, () => "/h"))
      .toThrow(/OREN_DRAIN_INTERVAL_MS/);
  });
});
