import { randomUUID } from "node:crypto";
import { PRODUCT_TZ } from "../time/clock.js";
import type { Agenda, Intent } from "../types.js";

export interface DueWindow {
  due_start: string;
  due_end: string;
  label: string;
}

/**
 * Parse Chinese relative schedule phrases into a due window anchored at spokenAt.
 * Returns null if no calendar commitment detected.
 */
export function parseDueWindowFromText(
  text: string,
  spokenAt: Date,
  timeZone = PRODUCT_TZ,
): DueWindow | null {
  const t = text.trim();
  if (!t) return null;

  // Cancellation / completion — handled elsewhere
  if (/别问了|不用提醒|取消提醒|别提了|已经搬完|搬完了|搞定了|不用管了/.test(t)) {
    return null;
  }

  // Need some future-ish cue
  const hasCue =
    /明天|后天|今晚|周末|这周|本周|下周|下个月|月底|月初|过两天|过几天|\d{1,2}\s*号|搬家|出发|见面|开会|截止|考试|起飞|出差/.test(
      t,
    );
  if (!hasCue) return null;

  const anchor = localYmd(spokenAt, timeZone);

  // Explicit day-of-month: 「15号」「12 号」— assume current or next month
  const dayM = t.match(/(?:(\d{1,2})\s*月)?\s*(\d{1,2})\s*号/);
  if (dayM) {
    const month = dayM[1] ? Number(dayM[1]) : anchor.month;
    const day = Number(dayM[2]);
    let year = anchor.year;
    let m = month;
    // if day already passed this month and no explicit month, roll next month
    if (!dayM[1] && (m < anchor.month || (m === anchor.month && day < anchor.day))) {
      m += 1;
      if (m > 12) {
        m = 1;
        year += 1;
      }
    }
    if (dayM[1] && month < anchor.month) year += 1;
    const start = zonedDate(year, m, day, 0, 0, timeZone);
    const end = zonedDate(year, m, day, 23, 59, timeZone);
    if (start && end) {
      return {
        due_start: start.toISOString(),
        due_end: end.toISOString(),
        label: `${m}月${day}号`,
      };
    }
  }

  if (/今晚|今天晚上/.test(t)) {
    const start = zonedDate(anchor.year, anchor.month, anchor.day, 18, 0, timeZone)!;
    const end = zonedDate(anchor.year, anchor.month, anchor.day, 23, 59, timeZone)!;
    return { due_start: start.toISOString(), due_end: end.toISOString(), label: "今晚" };
  }

  if (/明天/.test(t)) {
    const d = addLocalDays(anchor, 1);
    return windowForLocalDay(d, timeZone, "明天");
  }
  if (/后天/.test(t)) {
    const d = addLocalDays(anchor, 2);
    return windowForLocalDay(d, timeZone, "后天");
  }
  if (/过两天|过几天/.test(t)) {
    const a = addLocalDays(anchor, 2);
    const b = addLocalDays(anchor, 5);
    return {
      due_start: zonedDate(a.year, a.month, a.day, 0, 0, timeZone)!.toISOString(),
      due_end: zonedDate(b.year, b.month, b.day, 23, 59, timeZone)!.toISOString(),
      label: "过几天",
    };
  }
  if (/这周末|本周末|周末/.test(t) && !/下周末/.test(t)) {
    const sat = nextWeekday(anchor, 6); // Sat
    const sun = addLocalDays(sat, 1);
    return {
      due_start: zonedDate(sat.year, sat.month, sat.day, 0, 0, timeZone)!.toISOString(),
      due_end: zonedDate(sun.year, sun.month, sun.day, 23, 59, timeZone)!.toISOString(),
      label: "本周末",
    };
  }
  if (/下周/.test(t)) {
    // 说话日 +5 … +12 天作为「下周」窗口
    const a = addLocalDays(anchor, 5);
    const b = addLocalDays(anchor, 12);
    return {
      due_start: zonedDate(a.year, a.month, a.day, 0, 0, timeZone)!.toISOString(),
      due_end: zonedDate(b.year, b.month, b.day, 23, 59, timeZone)!.toISOString(),
      label: "下周左右",
    };
  }
  if (/下个月/.test(t)) {
    const a = addLocalDays(anchor, 20);
    const b = addLocalDays(anchor, 40);
    return {
      due_start: zonedDate(a.year, a.month, a.day, 0, 0, timeZone)!.toISOString(),
      due_end: zonedDate(b.year, b.month, b.day, 23, 59, timeZone)!.toISOString(),
      label: "下个月左右",
    };
  }
  if (/这周|本周/.test(t)) {
    const a = addLocalDays(anchor, 0);
    const b = addLocalDays(anchor, 6);
    return {
      due_start: zonedDate(a.year, a.month, a.day, 0, 0, timeZone)!.toISOString(),
      due_end: zonedDate(b.year, b.month, b.day, 23, 59, timeZone)!.toISOString(),
      label: "这周内",
    };
  }
  if (/月底/.test(t)) {
    const last = lastDayOfMonth(anchor.year, anchor.month);
    const a = { year: anchor.year, month: anchor.month, day: Math.max(1, last - 2) };
    const b = { year: anchor.year, month: anchor.month, day: last };
    return {
      due_start: zonedDate(a.year, a.month, a.day, 0, 0, timeZone)!.toISOString(),
      due_end: zonedDate(b.year, b.month, b.day, 23, 59, timeZone)!.toISOString(),
      label: "月底",
    };
  }

  // Event word without clear relative day — soft window +3..+10 days if 搬家 etc.
  if (/搬家|出发|出差|考试|起飞/.test(t)) {
    const a = addLocalDays(anchor, 3);
    const b = addLocalDays(anchor, 14);
    return {
      due_start: zonedDate(a.year, a.month, a.day, 0, 0, timeZone)!.toISOString(),
      due_end: zonedDate(b.year, b.month, b.day, 23, 59, timeZone)!.toISOString(),
      label: "近两周内（未指明日）",
    };
  }

  return null;
}

/** Build a deferred care intent from a user utterance. */
export function buildDeferredCareIntent(input: {
  text: string;
  spokenAt: Date;
  nowIso: string;
  maxCare?: number;
}): Intent | null {
  const window = parseDueWindowFromText(input.text, input.spokenAt);
  if (!window) return null;

  const topic = inferCareTopic(input.text);
  return {
    id: `in_${randomUUID().slice(0, 8)}`,
    kind: "think",
    title: `关心：${topic}（约${window.label}）`,
    status: "deferred",
    priority: 0.55,
    created_at: input.nowIso,
    source: "dialogue",
    due_start: window.due_start,
    due_end: window.due_end,
    care_count: 0,
    max_care: input.maxCare ?? 2,
    hints: {
      source_text: input.text.slice(0, 200),
      why: `用户在对话中提到日程：${window.label}`,
      open_questions: [`关于「${topic}」，到点了可以轻轻问一句进展吗？`],
    },
  };
}

/**
 * Promote deferred intents whose due window has started into pending at queue tail.
 * Does not insert at head (product: new/due items append only).
 */
export function promoteDueIntents(
  agenda: Agenda,
  now: Date,
  maxQueue: number,
): { agenda: Agenda; promoted: Intent[] } {
  const nowMs = now.getTime();
  const intents = { ...agenda.intents };
  const queue = [...agenda.queue];
  const promoted: Intent[] = [];

  for (const [id, it] of Object.entries(intents)) {
    if (it.status !== "deferred") continue;
    if (!it.due_start) continue;
    const start = Date.parse(it.due_start);
    if (!Number.isFinite(start) || nowMs < start) continue;

    // Past due_end by > 3 days and never promoted → skip as expired
    if (it.due_end) {
      const end = Date.parse(it.due_end);
      if (Number.isFinite(end) && nowMs > end + 3 * 86400_000 && !queue.includes(id)) {
        intents[id] = {
          ...it,
          status: "skipped",
          outcome: {
            at: now.toISOString(),
            summary: "日程窗口已过，未再打扰。",
          },
        };
        continue;
      }
    }

    const next: Intent = {
      ...it,
      status: "pending",
      priority: Math.max(it.priority, 0.6),
    };
    intents[id] = next;
    if (!queue.includes(id) && queue.length < maxQueue) {
      queue.push(id);
    }
    promoted.push(next);
  }

  return {
    agenda: {
      ...agenda,
      intents,
      queue,
      updated_at: now.toISOString(),
    },
    promoted,
  };
}

/** Register or refresh a deferred care item; dedupe by similar source. */
export function upsertDeferredCare(
  agenda: Agenda,
  care: Intent,
  nowIso: string,
): Agenda {
  const intents = { ...agenda.intents };
  // Dedupe: same topic keywords + still deferred/pending care
  const topicKey = normalizeTopicKey(care.title + (care.hints?.source_text ?? ""));
  for (const [id, it] of Object.entries(intents)) {
    if (it.source !== "dialogue") continue;
    if (it.status !== "deferred" && it.status !== "pending") continue;
    const key = normalizeTopicKey(it.title + (it.hints?.source_text ?? ""));
    if (key === topicKey || fuzzySameEvent(it.hints?.source_text, care.hints?.source_text)) {
      intents[id] = {
        ...it,
        due_start: care.due_start,
        due_end: care.due_end,
        title: care.title,
        hints: { ...it.hints, ...care.hints },
      };
      return { ...agenda, intents, updated_at: nowIso };
    }
  }
  intents[care.id] = care;
  // deferred: NOT in queue until promoted
  return { ...agenda, intents, updated_at: nowIso };
}

/** Cancel deferred/pending care when user says done / stop reminding. */
export function cancelCareFromUserText(
  agenda: Agenda,
  text: string,
  nowIso: string,
): { agenda: Agenda; cancelled: number } {
  const t = text.trim();
  const stop = /别问了|不用提醒|取消提醒|别提了|不用管了/.test(t);
  const done =
    /已经搬|搬完了|搞定了|已经走了|已经到了|不用担心|已经办完|结束了|取消了/.test(t);
  if (!stop && !done) return { agenda, cancelled: 0 };

  const intents = { ...agenda.intents };
  let cancelled = 0;
  for (const [id, it] of Object.entries(intents)) {
    if (it.source !== "dialogue") continue;
    if (it.status !== "deferred" && it.status !== "pending" && it.status !== "active") {
      continue;
    }
    if (!it.due_start && !/关心：/.test(it.title)) continue;
    // If user mentions a topic, prefer matching; else cancel all open care
    const src = `${it.title} ${it.hints?.source_text ?? ""}`;
    const topicHit =
      !done && !stop
        ? true
        : fuzzySameEvent(src, t) || /搬家|日程|提醒/.test(t) || stop || done;
    if (!topicHit) continue;
    intents[id] = {
      ...it,
      status: done ? "done" : "skipped",
      outcome: {
        at: nowIso,
        summary: done ? "用户表示事项已完成/可结束。" : "用户要求不再提醒。",
      },
    };
    cancelled++;
  }
  const queue = agenda.queue.filter((id) => {
    const it = intents[id];
    return it && (it.status === "pending" || it.status === "blocked" || it.status === "active");
  });
  return {
    agenda: { ...agenda, intents, queue, updated_at: nowIso },
    cancelled,
  };
}

export function listDeferred(agenda: Agenda): Intent[] {
  return Object.values(agenda.intents)
    .filter((i) => i.status === "deferred")
    .sort((a, b) => (a.due_start ?? "").localeCompare(b.due_start ?? ""));
}

export function formatDeferredForPlanPrompt(agenda: Agenda, now: Date): string {
  const items = listDeferred(agenda);
  if (items.length === 0) return "（无未到期的日历关心项）";
  return items
    .map((i) => {
      const start = i.due_start ? i.due_start.slice(0, 10) : "?";
      const end = i.due_end ? i.due_end.slice(0, 10) : "?";
      const due = Date.parse(i.due_start ?? "") <= now.getTime() ? "已到窗口" : "未到";
      return `- ${i.title} · ${start}～${end} · ${due} · 「${(i.hints?.source_text ?? "").slice(0, 40)}」`;
    })
    .join("\n");
}

// --- helpers ---

function inferCareTopic(text: string): string {
  if (/搬家/.test(text)) return "搬家";
  if (/出差/.test(text)) return "出差";
  if (/考试/.test(text)) return "考试";
  if (/起飞|航班|飞机/.test(text)) return "出行/航班";
  if (/见面|约会/.test(text)) return "见面";
  if (/开会|会议/.test(text)) return "开会";
  if (/截止|交/.test(text)) return "截止日期";
  const clip = text.replace(/我|准备|可能|大概|吧|啊|呢/g, "").trim();
  return clip.slice(0, 16) || "日程";
}

function normalizeTopicKey(s: string): string {
  return s.replace(/\s+/g, "").slice(0, 24);
}

function fuzzySameEvent(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const keys = ["搬家", "出差", "考试", "起飞", "见面", "开会", "截止"];
  for (const k of keys) {
    if (a.includes(k) && b.includes(k)) return true;
  }
  return a.slice(0, 12) === b.slice(0, 12);
}

interface Ymd {
  year: number;
  month: number;
  day: number;
}

function localYmd(d: Date, timeZone: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function addLocalDays(y: Ymd, days: number): Ymd {
  const utc = new Date(Date.UTC(y.year, y.month - 1, y.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextWeekday(from: Ymd, weekday: number): Ymd {
  // weekday: 0=Sun .. 6=Sat (JS)
  const utc = new Date(Date.UTC(from.year, from.month - 1, from.day));
  const cur = utc.getUTCDay();
  let add = (weekday - cur + 7) % 7;
  if (add === 0) add = 7; // next occurrence strictly in future if today
  return addLocalDays(from, add);
}

function windowForLocalDay(d: Ymd, timeZone: string, label: string): DueWindow {
  return {
    due_start: zonedDate(d.year, d.month, d.day, 0, 0, timeZone)!.toISOString(),
    due_end: zonedDate(d.year, d.month, d.day, 23, 59, timeZone)!.toISOString(),
    label,
  };
}

/** Approximate Asia/Shanghai (UTC+8 no DST) wall time → Date. */
function zonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  if (timeZone === "Asia/Shanghai" || timeZone === "Asia/Urumqi") {
    // CST = UTC+8
    return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0));
  }
  // Fallback: treat as local machine
  return new Date(year, month - 1, day, hour, minute, 0);
}
