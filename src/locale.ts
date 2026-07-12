/**
 * Product locale: Chinese-first (target users speak Chinese).
 * All solitary writing (plan / think / monologue / organize notes) defaults to zh-CN.
 */
export const PRODUCT_LOCALE = "zh-CN";

/** Inject into every generative system prompt. */
export const ZH_OUTPUT_RULE = `语言（强制）：
- 面向中文用户。独白、摘要、开放问题、计划标题、整理说明、分享话术一律使用简体中文。
- 即使阅读材料是英文，也用中文思考与书写；可保留专有名词原文，但解释用中文。
- 不要输出大段英文 monologue / summary / title（除非用户消息本身要求英文）。
- 计划 intents[].title 必须是中文短句（例如「接着想持续注意」「读未读的 beta.md」），禁止整句英文标题。`;

export function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/** True if text looks like it should have been Chinese but is not. */
export function lacksChinese(text: string | undefined | null): boolean {
  if (!text || !text.trim()) return true;
  return !hasCjk(text);
}