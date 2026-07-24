import { describe, expect, it } from "vitest";
import { createInitialLifeState, type EventEnvelope } from "@oren/kernel";
import { Scheduler } from "@oren/app";
import { openDatabase, SqliteLifeRepository } from "../src/index.js";

describe("durable inbox leases", () => {
  it("reclaims at the exact expiry boundary and rejects the stale lease token", () => {
    const db = openDatabase(":memory:");
    let token = 0;
    const repo = new SqliteLifeRepository(
      db,
      () => "2026-07-24T00:00:00.000Z",
      () => `lease-${++token}`,
    );
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    insertInbox(db, "wake:1", "oren-1", 2, {
      correlationId: "schedule:schedule-1",
      event: { type: "WakeDue", scheduleId: "schedule-1", purpose: "reflect" },
    });

    const first = repo.claimInbox("worker-1", "2026-07-24T00:00:00.000Z", 1)[0]!;
    const reclaimed = repo.claimInbox("worker-2", "2026-07-24T00:01:00.000Z", 1)[0]!;

    expect(first.leaseToken).toBe("lease-1");
    expect(reclaimed.leaseToken).toBe("lease-2");
    expect(repo.commitInbox(
      first.inboxId,
      first.orenId,
      first.leaseOwner,
      first.leaseToken,
      inboxTransition(first, "accepted-stale", "requested-stale"),
      "2026-07-24T00:01:00.000Z",
    )).toBe(false);
    expect(repo.commitInbox(
      reclaimed.inboxId,
      reclaimed.orenId,
      reclaimed.leaseOwner,
      reclaimed.leaseToken,
      inboxTransition(reclaimed, "accepted-current", "requested-current"),
      "2026-07-24T00:01:00.001Z",
    )).toBe(true);
  });

  it("quarantines corrupt and unsupported rows before leasing a valid later row", () => {
    const db = openDatabase(":memory:");
    let token = 0;
    const repo = new SqliteLifeRepository(
      db,
      () => "2026-07-24T00:00:00.000Z",
      () => `lease-${++token}`,
    );
    insertInbox(db, "corrupt", "oren-1", 9, "{");
    insertInbox(db, "unsupported", "oren-1", 8, {
      correlationId: "corr-unsupported",
      event: { type: "UserMessageReceived", personId: "person-1", text: "no" },
    });
    insertInbox(db, "valid", "oren-1", 1, {
      correlationId: "corr-valid",
      event: {
        type: "EffectFailed",
        effectId: "effect-1",
        code: "DECLINED",
        message: "declined",
      },
    });

    const claimed = repo.claimInbox("worker-1", "2026-07-24T00:00:00.000Z", 1);

    expect(claimed).toMatchObject([{
      inboxId: "valid",
      correlationId: "corr-valid",
      leaseOwner: "worker-1",
      leaseToken: "lease-1",
    }]);
    expect(db.prepare(`
      SELECT inbox_id FROM inbox_quarantine ORDER BY inbox_id
    `).all().map((row) => row.inbox_id)).toEqual(["corrupt", "unsupported"]);
  });

  it("validates durable Oren and event identities before committing any event", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db, undefined, () => "lease-1");
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    insertInbox(db, "wake:1", "oren-1", 2, {
      correlationId: "schedule:schedule-1",
      event: { type: "WakeDue", scheduleId: "schedule-1", purpose: "reflect" },
    });
    const claim = repo.claimInbox("worker-1", "2026-07-24T00:00:00.000Z", 1)[0]!;

    expect(() => repo.commitInbox(
      claim.inboxId,
      "oren-2",
      claim.leaseOwner,
      claim.leaseToken,
      [
        envelope("forged", "oren-2", claim.correlationId, claim.event),
        envelope("requested", "oren-2", claim.correlationId, {
          type: "CognitionRequested",
          episodeId: "episode-1",
          baseStateVersion: 2,
          triggerKind: "scheduled_wake",
        }),
      ],
      "2026-07-24T00:00:00.001Z",
    )).toThrow("belongs to another Oren");
    expect(() => repo.commitInbox(
      claim.inboxId,
      claim.orenId,
      claim.leaseOwner,
      claim.leaseToken,
      [
        envelope("forged", claim.orenId, "wrong-correlation", claim.event),
        envelope("requested", claim.orenId, claim.correlationId, {
          type: "CognitionRequested",
          episodeId: "episode-1",
          baseStateVersion: 2,
          triggerKind: "scheduled_wake",
        }),
      ],
      "2026-07-24T00:00:00.001Z",
    )).toThrow("event identity");
    expect(() => repo.commitInbox(
      claim.inboxId,
      claim.orenId,
      claim.leaseOwner,
      claim.leaseToken,
      [
        {
          ...envelope("forged", claim.orenId, claim.correlationId, claim.event),
          eventId: 7,
        } as unknown as EventEnvelope,
        envelope("requested", claim.orenId, claim.correlationId, {
          type: "CognitionRequested",
          episodeId: "episode-1",
          baseStateVersion: 2,
          triggerKind: "scheduled_wake",
        }),
      ],
      "2026-07-24T00:00:00.001Z",
    )).toThrow("event envelope identity");
    expect(db.prepare("SELECT processed_at FROM inbox WHERE inbox_id = ?").get(claim.inboxId))
      .toEqual({ processed_at: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  });

  it("accepts exactly the durable inbox event followed by its matching cognition request", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db, undefined, () => "lease-1");
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    insertInbox(db, "wake:1", "oren-1", 2, {
      correlationId: "schedule:schedule-1",
      event: { type: "WakeDue", scheduleId: "schedule-1", purpose: "reflect" },
    });
    const claim = repo.claimInbox("worker-1", "2026-07-24T00:00:00.000Z", 1)[0]!;

    expect(repo.commitInbox(
      claim.inboxId,
      claim.orenId,
      claim.leaseOwner,
      claim.leaseToken,
      [
        envelope("accepted", claim.orenId, claim.correlationId, claim.event),
        envelope("requested", claim.orenId, claim.correlationId, {
          type: "CognitionRequested",
          episodeId: "episode-1",
          baseStateVersion: 2,
          triggerKind: "scheduled_wake",
        }),
      ],
      "2026-07-24T00:00:00.001Z",
    )).toBe(true);
    expect(repo.loadEvents("oren-1").map((event) => event.payload.type)).toEqual([
      "WakeDue",
      "CognitionRequested",
    ]);
  });

  it.each([
    {
      name: "missing request",
      events: (claim: ReturnType<SqliteLifeRepository["claimInbox"]>[number]) => [
        envelope("accepted", claim.orenId, claim.correlationId, claim.event),
      ],
    },
    {
      name: "extra event",
      events: (claim: ReturnType<SqliteLifeRepository["claimInbox"]>[number]) => [
        ...inboxTransition(claim, "accepted", "requested"),
        envelope("extra", claim.orenId, claim.correlationId, {
          type: "CognitionFailed",
          episodeId: "episode-1",
          message: "hostile",
        }),
      ],
    },
    {
      name: "wrong trigger",
      events: (claim: ReturnType<SqliteLifeRepository["claimInbox"]>[number]) => [
        envelope("accepted", claim.orenId, claim.correlationId, claim.event),
        envelope("requested", claim.orenId, claim.correlationId, {
          type: "CognitionRequested",
          episodeId: "episode-1",
          baseStateVersion: 2,
          triggerKind: "effect_result",
        }),
      ],
    },
    {
      name: "unknown second event",
      events: (claim: ReturnType<SqliteLifeRepository["claimInbox"]>[number]) => [
        envelope("accepted", claim.orenId, claim.correlationId, claim.event),
        envelope("hostile", claim.orenId, claim.correlationId, {
          type: "FutureEvent",
        } as unknown as EventEnvelope["payload"]),
      ],
    },
  ])("atomically rejects an inbox transition with $name", ({ events }) => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db, undefined, () => "lease-1");
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    insertInbox(db, "wake:1", "oren-1", 2, {
      correlationId: "schedule:schedule-1",
      event: { type: "WakeDue", scheduleId: "schedule-1", purpose: "reflect" },
    });
    const claim = repo.claimInbox("worker-1", "2026-07-24T00:00:00.000Z", 1)[0]!;

    expect(() => repo.commitInbox(
      claim.inboxId,
      claim.orenId,
      claim.leaseOwner,
      claim.leaseToken,
      events(claim),
      "2026-07-24T00:00:00.001Z",
    )).toThrow(/transition|event|payload/i);
    expect(repo.loadEvents("oren-1")).toEqual([]);
    expect(db.prepare("SELECT processed_at FROM inbox WHERE inbox_id = ?").get(claim.inboxId))
      .toEqual({ processed_at: null });
  });
});

describe("durable scheduled wakes", () => {
  it("passes the claimed schedule shape to repository adapters", () => {
    const due = {
      scheduleId: "schedule-1",
      orenId: "oren-1",
      purpose: "reflect",
    };
    const delivered: unknown[] = [];
    const scheduler = new Scheduler({
      claimDue: () => [due],
      deliverWake: (schedule) => {
        delivered.push(schedule);
      },
    });

    expect(scheduler.runOnce("2026-07-24T00:00:00.000Z")).toBe(1);
    expect(delivered).toEqual([due]);
  });

  it("lets concurrent schedulers deliver one wake using repository-owned identity", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    db.prepare(`
      INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
      VALUES (?, ?, ?, ?)
    `).run(
      "schedule-1",
      "oren-1",
      "2026-07-24T00:00:00.000Z",
      "durable purpose",
    );
    const first = new Scheduler(repo);
    const second = new Scheduler(repo);

    expect(first.runOnce("2026-07-24T00:00:00.000Z")).toBe(1);
    expect(second.runOnce("2026-07-24T00:00:00.000Z")).toBe(0);
    expect(db.prepare(`
      SELECT inbox_id, oren_id, available_at, payload_json FROM inbox
    `).get()).toEqual({
      inbox_id: "wake:schedule-1",
      oren_id: "oren-1",
      available_at: "2026-07-24T00:00:00.000Z",
      payload_json: JSON.stringify({
        correlationId: "schedule:schedule-1",
        event: {
          type: "WakeDue",
          scheduleId: "schedule-1",
          purpose: "durable purpose",
        },
      }),
    });
  });

  it("ignores caller-forged schedule fields and loads the durable identity", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    db.prepare(`
      INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
      VALUES (?, ?, ?, ?)
    `).run(
      "schedule-1",
      "oren-durable",
      "2026-07-24T00:00:00.000Z",
      "durable purpose",
    );
    const scheduler = new Scheduler({
      claimDue: () => [{
        scheduleId: "schedule-1",
        orenId: "oren-forged",
        purpose: "forged purpose",
      }],
      deliverWake: (scheduleId, now) => repo.deliverWake(scheduleId, now),
    });

    expect(scheduler.runOnce("2026-07-24T00:00:00.000Z")).toBe(1);
    expect(db.prepare("SELECT oren_id, payload_json FROM inbox").get()).toEqual({
      oren_id: "oren-durable",
      payload_json: JSON.stringify({
        correlationId: "schedule:schedule-1",
        event: {
          type: "WakeDue",
          scheduleId: "schedule-1",
          purpose: "durable purpose",
        },
      }),
    });
  });

  it("does not deliver a missing, future, or already-delivered schedule", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    db.prepare(`
      INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
      VALUES (?, ?, ?, ?)
    `).run(
      "future",
      "oren-1",
      "2026-07-25T00:00:00.000Z",
      "later",
    );

    expect(repo.deliverWake("missing", "2026-07-24T00:00:00.000Z")).toBe(false);
    expect(repo.deliverWake("future", "2026-07-24T00:00:00.000Z")).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM inbox").get()).toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT delivered_at FROM schedules WHERE schedule_id = 'future'
    `).get()).toEqual({ delivered_at: null });
  });

  it("rejects invalid caller time and compares valid offsets as the same instant", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    db.prepare(`
      INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
      VALUES (?, ?, ?, ?)
    `).run("schedule-1", "oren-1", "2026-07-24T00:00:00.000Z", "reflect");

    expect(() => repo.claimDue("zzzz", 32)).toThrow(/time|timestamp|instant/i);
    expect(() => new Scheduler(repo).runOnce("zzzz")).toThrow(/time|timestamp|instant/i);
    expect(repo.claimDue("2026-07-24T08:00:00+08:00", 32)).toMatchObject([
      { scheduleId: "schedule-1" },
    ]);
    expect(repo.deliverWake("schedule-1", "2026-07-24T08:00:00+08:00")).toBe(true);
  });

  it("quarantines malformed durable due_at without starving a later valid schedule", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    db.prepare(`
      INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      "malformed", "oren-1", "zzzz", "bad",
      "valid", "oren-1", "2026-07-24T00:00:00.000Z", "good",
    );

    expect(new Scheduler(repo).runOnce("2026-07-24T00:00:00.000Z")).toBe(1);
    expect(db.prepare("SELECT schedule_id FROM schedule_quarantine").all())
      .toEqual([{ schedule_id: "malformed" }]);
    expect(db.prepare("SELECT inbox_id FROM inbox").all())
      .toEqual([{ inbox_id: "wake:valid" }]);
  });

  it("treats schedule IDs as immutable one-shot occurrence identities", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    repo.initialize(createInitialLifeState("oren-1", "person-1"));
    const scheduled = envelope("scheduled-1", "oren-1", "corr-1", {
      type: "WakeScheduled",
      scheduleId: "schedule-1",
      at: "2026-07-24T00:00:00.000Z",
      purpose: "reflect",
    });
    repo.commit("oren-1", [scheduled]);
    repo.commit("oren-1", [{ ...scheduled, eventId: "scheduled-identical" }]);
    expect(repo.deliverWake("schedule-1", "2026-07-24T00:00:00.000Z")).toBe(true);

    expect(() => repo.commit("oren-1", [{
      ...scheduled,
      eventId: "scheduled-after-delivery",
    }])).toThrow(/one-shot|delivered|conflict/i);
    expect(() => repo.commit("oren-1", [{
      ...scheduled,
      eventId: "scheduled-changed",
      payload: {
        type: "WakeScheduled",
        scheduleId: "schedule-1",
        at: "2026-07-24T00:00:00.000Z",
        purpose: "changed",
      },
    }])).toThrow(/one-shot|delivered|conflict/i);
    expect(db.prepare("SELECT delivered_at FROM schedules WHERE schedule_id = ?").get("schedule-1"))
      .toEqual({ delivered_at: "2026-07-24T00:00:00.000Z" });
  });

  it("quarantines a schedule with a conflicting wake inbox and delivers a later row", () => {
    const db = openDatabase(":memory:");
    const repo = new SqliteLifeRepository(db);
    db.prepare(`
      INSERT INTO schedules(schedule_id, oren_id, due_at, purpose)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      "conflict", "oren-1", "2026-07-24T00:00:00.000Z", "first",
      "valid", "oren-1", "2026-07-24T00:00:00.001Z", "second",
    );
    insertInbox(db, "wake:conflict", "oren-other", 9, {
      correlationId: "hostile",
      event: { type: "WakeDue", scheduleId: "other", purpose: "forged" },
    });

    const scheduler = new Scheduler(repo);
    expect(scheduler.runOnce("2026-07-24T00:00:00.001Z")).toBe(1);
    expect(db.prepare("SELECT schedule_id FROM schedule_quarantine").all())
      .toEqual([{ schedule_id: "conflict" }]);
    expect(db.prepare(`
      SELECT schedule_id, delivered_at FROM schedules ORDER BY schedule_id
    `).all()).toEqual([
      { schedule_id: "conflict", delivered_at: null },
      { schedule_id: "valid", delivered_at: "2026-07-24T00:00:00.001Z" },
    ]);
  });

  it("isolates a repository failure to one due schedule", () => {
    const attempts: string[] = [];
    const scheduler = new Scheduler({
      claimDue: () => [
        { scheduleId: "bad", orenId: "oren-1", purpose: "bad" },
        { scheduleId: "good", orenId: "oren-1", purpose: "good" },
      ],
      deliverWake: (schedule) => {
        attempts.push(schedule.scheduleId);
        if (schedule.scheduleId === "bad") throw new Error("corrupt row");
        return true;
      },
    });

    expect(scheduler.runOnce("2026-07-24T00:00:00.000Z")).toBe(1);
    expect(attempts).toEqual(["bad", "good"]);
  });
});

function insertInbox(
  db: ReturnType<typeof openDatabase>,
  inboxId: string,
  orenId: string,
  priority: number,
  payload: unknown,
) {
  db.prepare(`
    INSERT INTO inbox(inbox_id, oren_id, priority, available_at, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    inboxId,
    orenId,
    priority,
    "2026-07-24T00:00:00.000Z",
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
}

function envelope(
  eventId: string,
  orenId: string,
  correlationId: string,
  payload: EventEnvelope["payload"],
): EventEnvelope {
  return {
    eventId,
    orenId,
    schemaVersion: 1,
    occurredAt: "2026-07-24T00:00:00.000Z",
    recordedAt: "2026-07-24T00:00:00.000Z",
    source: "life-actor",
    causationId: null,
    correlationId,
    payload,
  };
}

function inboxTransition(
  claim: ReturnType<SqliteLifeRepository["claimInbox"]>[number],
  acceptedId: string,
  requestedId: string,
): EventEnvelope[] {
  return [
    envelope(acceptedId, claim.orenId, claim.correlationId, claim.event),
    envelope(requestedId, claim.orenId, claim.correlationId, {
      type: "CognitionRequested",
      episodeId: "episode-1",
      baseStateVersion: 2,
      triggerKind: claim.event.type === "WakeDue" ? "scheduled_wake" : "effect_result",
    }),
  ];
}
