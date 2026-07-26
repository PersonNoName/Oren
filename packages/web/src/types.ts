export const WEB_READ_MAX_CHARS = 8192;
export const WEB_SEARCH_MAX_RESULTS = 5;
export const WEB_SEARCH_DEFAULT_LIMIT = 3;

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchResult {
  readonly results: readonly SearchHit[];
}

export interface ReadResult {
  readonly url: string;
  readonly title?: string;
  readonly text: string;
}

export interface WebPort {
  search(input: { query: string; limit: number }): Promise<SearchResult>;
  read(input: { url: string }): Promise<ReadResult>;
}

export type UrlSafetyResult =
  | { readonly ok: true; readonly href: string }
  | { readonly ok: false; readonly reason: string };
