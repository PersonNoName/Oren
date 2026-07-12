import type { DialogueTurn } from "../types.js";

/** Default product timezone for Chinese users. */
export const PRODUCT_TZ = "Asia/Shanghai";

/**
 * Wall-clock block for every generative prompt.
 * Models do not know "now" unless we inject it.
 */
export function formatClockForPrompt(now: Date, timeZone = PRODUCT_TZ): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const local = `${get("year")}-${get("month")}-${get("day")} ${get("weekday")} ${get("hour")}:${get("minute")}:${get("second")}`;

  return [
    `时区：${timeZone}`,
    `本地现在：${local}`,
    `UTC：${now.toISOString()}`,
    "推算规则：用户说「明天/下周/下个月」时，以【该句话的时间戳】为基准，再与【本地现在】比较；未到窗口不要当成已发生，也不要反复追问「做了吗」。",
  ].join("\n");
}

/** Human relative span in Chinese. */
export function formatRelativeZh(fromIso: string, now: Date): string {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return "时间未知";
  const ms = now.getTime() - from;
  if (ms < 0) {
    const abs = -ms;
    if (abs < 60_000) return "片刻后";
    if (abs < 3600_000) return `${Math.round(abs / 60_000)} 分钟后`;
    if (abs < 86400_000) return `${Math.round(abs / 3600_000)} 小时后`;
    return `${Math.round(abs / 86400_000)} 天后`;
  }
  if (ms < 60_000) return "刚才";
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} 分钟前`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)} 小时前`;
  if (ms < 7 * 86400_000) return `${Math.round(ms / 86400_000)} 天前`;
  if (ms < 30 * 86400_000) return `${Math.round(ms / (7 * 86400_000))} 周前`;
  return `${Math.round(ms / (30 * 86400_000))} 个月前`;
}

export function formatLocalShort(iso: string, timeZone = PRODUCT_TZ): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** Dialogue line with absolute + relative time (for model temporal reasoning). */
export function formatDialogueLineForPrompt(turn: DialogueTurn, now: Date): string {
  const who = turn.role === "user" ? "用户" : "Oren";
  const when = turn.ts
    ? `${formatLocalShort(turn.ts)}（${formatRelativeZh(turn.ts, now)}）`
    : "时间未知";
  return `[${when}] ${who}：${turn.text}`;
}

/**
 * Pull user lines that look time-sensitive so the model can track commitments.
 */
export function formatTemporalUserMentions(
  history: DialogueTurn[],
  now: Date,
  limit = 12,
): string {
  const re =
    /明天|后天|今晚|周末|下周|下个月|这周|本周|月底|月初|年后|搬家|截止|开会|见面|起飞|考试|出发|回家|出差|约会|号|日之前|之后|待会|一会儿|下次/;
  const hits: string[] = [];
  for (const t of history) {
    if (t.role !== "user") continue;
    if (!re.test(t.text)) continue;
    const when = t.ts
      ? `${formatLocalShort(t.ts)}（${formatRelativeZh(t.ts, now)}说的）`
      : "未知时间";
    hits.push(`- [${when}] 「${t.text.slice(0, 160)}」`);
    if (hits.length >= limit) break;
  }
  // Prefer most recent: history is chronological, keep last N matches in order
  return hits.length
    ? hits.join("\n")
    : "（近期对话里没有明显的时间承诺/日程用语）";
}

/** System-prompt rules for temporal common sense. */
export const TEMPORAL_DIALOGUE_RULES = `时间（强制）：
- 系统会提供「本地现在」与每条历史的时间戳；你必须用它们推算，不要假装不知道今天几号。
- 用户说「下周搬家」：以【他说这句话的日期】加约 7 天为窗口，在窗口未到前不要问「搬家了吗 / 搬完了吗」。
- 窗口已过可以关心进展，但只问一次语气；用户若已回答，记住结论，不要反复追问。
- 不要把「过了一会儿再聊」当成「约定事项已经发生」。
- 不确定时宁可说「按你之前说的时间，好像还没到 / 应该差不多了」，不要瞎猜。`;
