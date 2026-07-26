import { assertSafeHttpUrl } from "./url-safety.js";
import type { ReadResult, SearchResult, WebPort } from "./types.js";
import { WEB_READ_MAX_CHARS, WEB_SEARCH_MAX_RESULTS } from "./types.js";

type ScriptedHandlers = {
  search: (query: string, limit: number) => SearchResult | Promise<SearchResult>;
  read: (url: string) => ReadResult | Promise<ReadResult>;
};

export class ScriptedWebAdapter implements WebPort {
  public constructor(private readonly handlers: ScriptedHandlers) {}

  public async search(input: { query: string; limit: number }): Promise<SearchResult> {
    const limit = Math.min(Math.max(1, input.limit), WEB_SEARCH_MAX_RESULTS);
    const result = await this.handlers.search(input.query, limit);
    const results = result.results
      .filter((hit) => assertSafeHttpUrl(hit.url).ok)
      .slice(0, limit);
    return { results };
  }

  public async read(input: { url: string }): Promise<ReadResult> {
    const safety = assertSafeHttpUrl(input.url);
    if (!safety.ok) {
      throw new Error(safety.reason);
    }

    const result = await this.handlers.read(safety.href);
    return {
      ...result,
      url: safety.href,
      text: result.text.slice(0, WEB_READ_MAX_CHARS),
    };
  }
}
