import { HttpWebAdapter } from "./http-adapter.js";
import type { WebPort } from "./types.js";

export const WEB_SEARCH_PROVIDER_ENV = "OREN_WEB_SEARCH_PROVIDER";
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";

export type WebConfigResult =
  | { readonly ok: true; readonly adapter: WebPort }
  | { readonly ok: false; readonly kind: "unconfigured" | "invalid"; readonly reason: string };

export function resolveWebConfig(
  env: Readonly<Record<string, string | undefined>>,
): WebConfigResult {
  const provider = env[WEB_SEARCH_PROVIDER_ENV]?.trim();
  const apiKey = env[TAVILY_API_KEY_ENV]?.trim();
  if (!provider) {
    return {
      ok: false,
      kind: "unconfigured",
      reason: `Web search is disabled. Set ${WEB_SEARCH_PROVIDER_ENV} and ${TAVILY_API_KEY_ENV} `
        + "to enable it.",
    };
  }
  if (provider !== "tavily") {
    return {
      ok: false,
      kind: "invalid",
      reason: `Unknown web search provider "${provider}". Known providers: tavily.`,
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      kind: "invalid",
      reason: `Missing API key for web search provider "${provider}". `
        + `Set ${TAVILY_API_KEY_ENV}.`,
    };
  }
  return { ok: true, adapter: new HttpWebAdapter({ apiKey }) };
}
