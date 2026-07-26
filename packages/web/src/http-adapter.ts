import { assertSafeHttpUrl } from "./url-safety.js";
import type { ReadResult, SearchResult, WebPort } from "./types.js";
import {
  WEB_READ_MAX_CHARS,
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_MAX_RESULTS,
} from "./types.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const WEB_REQUEST_TIMEOUT_MS = 10_000;
const WEB_READ_MAX_BYTES = 512 * 1024;

type FetchFn = typeof fetch;

interface TavilySearchResponse {
  readonly results?: ReadonlyArray<{
    readonly title?: string;
    readonly url?: string;
    readonly content?: string;
    readonly snippet?: string;
  }>;
}

export function extractReadableText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }

  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const remaining = maxBytes - totalBytes;
    if (value.length > remaining) {
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      break;
    }
    text += decoder.decode(value, { stream: true });
    totalBytes += value.length;
  }
  return text;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

async function fetchWithSafeRedirects(
  fetchFn: FetchFn,
  initialUrl: string,
  init: RequestInit,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchFn(currentUrl, {
      ...init,
      redirect: "manual",
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (location === null || location.length === 0) {
        throw new Error("Redirect response missing Location header");
      }
      const redirectTarget = new URL(location, currentUrl).href;
      const safety = assertSafeHttpUrl(redirectTarget);
      if (!safety.ok) {
        throw new Error(safety.reason);
      }
      currentUrl = safety.href;
      continue;
    }

    const finalUrl = response.url.length > 0 ? response.url : currentUrl;
    const finalSafety = assertSafeHttpUrl(finalUrl);
    if (!finalSafety.ok) {
      throw new Error(finalSafety.reason);
    }

    return { response, finalUrl: finalSafety.href };
  }

  throw new Error("Too many redirects");
}

export class HttpWebAdapter implements WebPort {
  public constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly fetchFn?: FetchFn;
    },
  ) {}

  public async search(input: { query: string; limit: number }): Promise<SearchResult> {
    const limit = Math.min(Math.max(1, input.limit), WEB_SEARCH_MAX_RESULTS);
    const fetchFn = this.options.fetchFn ?? fetch;
    const response = await fetchFn(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.options.apiKey,
        query: input.query,
        max_results: limit,
      }),
      signal: AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Tavily search failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json() as TavilySearchResponse;
    const results = (body.results ?? [])
      .map((hit) => ({
        title: hit.title ?? "",
        url: hit.url ?? "",
        snippet: hit.content ?? hit.snippet ?? "",
      }))
      .filter((hit) => hit.url.length > 0 && assertSafeHttpUrl(hit.url).ok)
      .slice(0, limit);
    return { results };
  }

  public async read(input: { url: string }): Promise<ReadResult> {
    const safety = assertSafeHttpUrl(input.url);
    if (!safety.ok) {
      throw new Error(safety.reason);
    }

    const fetchFn = this.options.fetchFn ?? fetch;
    const { response, finalUrl } = await fetchWithSafeRedirects(fetchFn, safety.href, {
      signal: AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS),
      headers: { "user-agent": "OrenWebReader/1.0" },
    });
    if (!response.ok) {
      throw new Error(`Page fetch failed: ${response.status} ${response.statusText}`);
    }

    const html = await readResponseText(response, WEB_READ_MAX_BYTES);
    const text = extractReadableText(html).slice(0, WEB_READ_MAX_CHARS);
    return { url: finalUrl, text };
  }
}
