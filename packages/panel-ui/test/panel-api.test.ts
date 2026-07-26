import { describe, expect, it, vi } from "vitest";
import {
  fetchSnapshot,
  postMessage,
  revokeGrant,
  updateCommitment,
  updateReachability,
} from "../src/lib/panel-api.js";
import type { PanelSnapshot } from "../src/lib/panel-types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const emptySnap: PanelSnapshot = {
  inbox: [],
  attention: { activeThreadIds: [], currentFocus: null, unresolvedQuestions: [] },
  commitments: [],
  budgets: {
    autonomyRemaining: 0,
    interactionMaxSteps: 8,
    commitmentRemaining: {},
    webQuotaRemaining: 8,
  },
  grants: [],
  schedules: [],
  actionLedger: [],
  publicDiary: [],
  reachability: {
    quietHours: { start: "22:00", end: "08:00", timezone: "UTC" },
    maxProactivePerDay: 3,
    deferWhenQuiet: true,
    proactiveDayKey: null,
    proactiveCountToday: 0,
  },
};

describe("panel-api", () => {
  it("fetchSnapshot GETs /api/snapshot", async () => {
    const fetcher = vi.fn(async () => jsonResponse(emptySnap));
    const snap = await fetchSnapshot(fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/snapshot");
    expect(snap.inbox).toEqual([]);
  });

  it("fetchSnapshot throws on non-OK", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "x" }, 500));
    await expect(fetchSnapshot(fetcher)).rejects.toThrow(/snapshot/i);
  });

  it("postMessage POSTs JSON text", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    await postMessage("hello", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
  });

  it("updateCommitment POSTs to commitment id path", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    await updateCommitment("c1", { status: "paused", reason: "wait" }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/commitments/c1", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ status: "paused", reason: "wait" }),
    }));
  });

  it("revokeGrant POSTs reason", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    await revokeGrant("g1", "nope", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/grants/g1/revoke", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reason: "nope" }),
    }));
  });

  it("updateReachability POSTs policy + reason", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ ok: true }));
    await updateReachability(emptySnap.reachability, "tune", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/reachability", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ policy: emptySnap.reachability, reason: "tune" }),
    }));
  });
});
