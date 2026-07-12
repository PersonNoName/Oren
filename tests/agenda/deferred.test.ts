import { describe, expect, it } from "vitest";
import {
  buildDeferredCareIntent,
  parseDueWindowFromText,
  promoteDueIntents,
  upsertDeferredCare,
  cancelCareFromUserText,
} from "../../src/agenda/deferred.js";
import { defaultAgenda } from "../../src/types.js";

describe("deferred calendar cares", () => {
  it("parses 下周 into a future window", () => {
    const spoken = new Date("2026-07-05T12:00:00+08:00");
    const w = parseDueWindowFromText("我下周搬家", spoken);
    expect(w).not.toBeNull();
    expect(w!.label).toMatch(/下周/);
    const start = Date.parse(w!.due_start);
    const end = Date.parse(w!.due_end);
    // about +5..+12 days
    expect(start).toBeGreaterThan(spoken.getTime() + 4 * 86400_000);
    expect(end).toBeGreaterThan(start);
  });

  it("builds deferred intent not in queue until promoted", () => {
    const now = new Date("2026-07-05T12:00:00.000Z");
    const care = buildDeferredCareIntent({
      text: "我下周搬家",
      spokenAt: now,
      nowIso: now.toISOString(),
    });
    expect(care?.status).toBe("deferred");
    let agenda = defaultAgenda(now.toISOString());
    agenda = upsertDeferredCare(agenda, care!, now.toISOString());
    expect(agenda.queue).toHaveLength(0);
    expect(Object.values(agenda.intents).some((i) => i.status === "deferred")).toBe(
      true,
    );

    const later = new Date(now.getTime() + 8 * 86400_000);
    const { agenda: next, promoted } = promoteDueIntents(agenda, later, 7);
    expect(promoted.length).toBe(1);
    expect(next.queue).toContain(promoted[0]!.id);
    expect(next.intents[promoted[0]!.id]!.status).toBe("pending");
  });

  it("does not promote before due_start", () => {
    const now = new Date("2026-07-05T12:00:00.000Z");
    const care = buildDeferredCareIntent({
      text: "我下周搬家",
      spokenAt: now,
      nowIso: now.toISOString(),
    })!;
    let agenda = upsertDeferredCare(defaultAgenda(now.toISOString()), care, now.toISOString());
    const { promoted } = promoteDueIntents(agenda, new Date(now.getTime() + 86400_000), 7);
    expect(promoted).toHaveLength(0);
  });

  it("cancels care on user stop", () => {
    const now = new Date("2026-07-05T12:00:00.000Z");
    const care = buildDeferredCareIntent({
      text: "我下周搬家",
      spokenAt: now,
      nowIso: now.toISOString(),
    })!;
    let agenda = upsertDeferredCare(defaultAgenda(now.toISOString()), care, now.toISOString());
    const r = cancelCareFromUserText(agenda, "搬完了不用提醒了", now.toISOString());
    expect(r.cancelled).toBeGreaterThan(0);
    expect(Object.values(r.agenda.intents).every((i) => i.status !== "deferred")).toBe(
      true,
    );
  });
});
