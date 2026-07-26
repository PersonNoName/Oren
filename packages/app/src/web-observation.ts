import { WEB_READ_MAX_CHARS } from "@oren/web";

export interface SearchObservation {
  readonly kind: "web_search_result";
  readonly sourceUrl: string;
  readonly title: string;
  readonly excerpt: string;
  readonly query: string;
}

export interface ReadObservation {
  readonly kind: "web_page";
  readonly sourceUrl: string;
  readonly title?: string;
  readonly excerpt: string;
}

export function formatSearchExcerpt(
  results: readonly { title: string; url: string; snippet: string }[],
): string {
  return results
    .map(({ title, url, snippet }, index) =>
      `[${index + 1}] ${title}\n${url}\n${snippet}`)
    .join("\n\n")
    .slice(0, WEB_READ_MAX_CHARS);
}

export function observationFromSearch(
  query: string,
  results: readonly { title: string; url: string; snippet: string }[],
): SearchObservation | null {
  const first = results[0];
  if (first === undefined) return null;
  return {
    kind: "web_search_result",
    sourceUrl: first.url,
    title: `搜索：${query}`,
    excerpt: formatSearchExcerpt(results),
    query,
  };
}

export function observationFromRead(
  result: { url: string; title?: string; text: string },
): ReadObservation | null {
  const excerpt = result.text.slice(0, WEB_READ_MAX_CHARS);
  if (excerpt.trim().length === 0) {
    return null;
  }
  return {
    kind: "web_page",
    sourceUrl: result.url,
    ...(result.title !== undefined ? { title: result.title } : {}),
    excerpt,
  };
}
