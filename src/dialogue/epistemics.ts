/**
 * Product epistemics (locked decisions):
 * 1) Elastic mode — free to say "I'm thinking…"; "I read…" needs corpus evidence.
 * 2) Oren can write — monologues / notes are self-authored (kind=write).
 * 3) Thin materials OK — admit when the shelf is only a few local notes.
 *
 * Hallucination (invented books, fake citations) is the worst failure mode.
 */

import type { ShareKind, Thread } from "../types.js";

export const EPISTEMIC_POLICY = {
  mode: "elastic" as const,
  canWrite: true,
  thinMaterialsOk: true,
};

/** True if text claims external/read material (stricter than think/write). */
export function claimsReading(text: string): boolean {
  // Strip common negations so "没在读 / not reading" does not count as a claim.
  const t = text
    .replace(/没(有)?在读|不在读|没读|不读|谈不上在读|说不上在读|并非在读/gi, " ")
    .replace(/\bnot\s+reading\b|\bin'?t\s+reading\b|\bdidn'?t\s+read\b/gi, " ");
  return /(在读|读到|看了一本|看过一本|我读|最近在看|来自书|书里|from (the )?book|i('m| am) reading|i read|textbook|monograph|《[^》]+》|(一本|那本|这本).{0,12}(书|著作|读物))/i.test(
    t,
  );
}

export function claimsSelfWriting(text: string): boolean {
  return /(我写|写了|记下|我的笔记|我的独白|i wrote|my note|my monologue|草稿)/i.test(
    text,
  );
}

export function parseShareKind(raw: unknown): ShareKind | undefined {
  if (typeof raw !== "string") return undefined;
  const k = raw.toLowerCase().trim();
  if (k === "read" || k === "think" || k === "write") return k;
  return undefined;
}

/**
 * Infer kind when the model omits it.
 * Prefer explicit reading claims → read; self-writing → write; else think (elastic).
 */
export function inferShareKind(
  snippet: string | undefined,
  reason: string | undefined,
  thread: Thread,
): ShareKind {
  const blob = `${snippet ?? ""} ${reason ?? ""}`;
  if (claimsReading(blob)) return "read";
  if (claimsSelfWriting(blob)) return "write";
  if ((thread.quotes ?? []).length > 0 && /quote|corpus|path|\.md/i.test(blob)) {
    return "read";
  }
  return "think";
}

export function shareKindLabel(kind: ShareKind | undefined): string {
  switch (kind) {
    case "read":
      return "阅读";
    case "write":
      return "自写";
    case "think":
      return "所思";
    default:
      return "分享";
  }
}
