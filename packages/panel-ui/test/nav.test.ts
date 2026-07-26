import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "../src/lib/nav.js";

describe("NAV_ITEMS", () => {
  it("lists observatory sections in order", () => {
    expect(NAV_ITEMS.map((i) => i.id)).toEqual([
      "overview",
      "inbox",
      "commitments",
      "grants",
      "budgets",
      "reachability",
      "ledger",
    ]);
  });
});
