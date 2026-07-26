import type { OrenExtension } from "@oren/extensions";
import type { JsonValue } from "@oren/kernel";
import type { WebPort } from "./types.js";
import { WEB_SEARCH_DEFAULT_LIMIT, WEB_SEARCH_MAX_RESULTS } from "./types.js";

const WEB_TRAITS = ["read_only", "replay_safe", "billable"] as const;
const WEB_TIMEOUT_MS = 10_000;

export function createWebExtension(port: WebPort): OrenExtension {
  return {
    manifest: {
      id: "web",
      version: "1.0.0",
      protocolVersion: 1,
      eventSources: [],
      capabilities: [
        {
          extensionId: "web",
          name: "web.search",
          description: "搜索公开网页，返回标题、链接与摘要片段。",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "搜索查询" },
              limit: { type: "number", description: "结果数量上限（默认 3，最大 5）" },
            },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    url: { type: "string" },
                    snippet: { type: "string" },
                  },
                },
              },
            },
          },
          permissionRequirements: [],
          traits: [...WEB_TRAITS],
          cancellable: true,
          timeoutMs: WEB_TIMEOUT_MS,
        },
        {
          extensionId: "web",
          name: "web.read",
          description: "读取公开网页正文（经安全校验与截断）。",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "要读取的 http(s) URL" },
            },
            required: ["url"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              title: { type: "string" },
              text: { type: "string" },
            },
          },
          permissionRequirements: [],
          traits: [...WEB_TRAITS],
          cancellable: true,
          timeoutMs: WEB_TIMEOUT_MS,
        },
      ],
    },
    async activate() {},
    async deactivate() {},
    async invoke(invocation) {
      if (invocation.capability === "web.search") {
        const args = parseSearchArguments(invocation.arguments);
        if (args === undefined) {
          return {
            status: "failed",
            code: "invalid_arguments",
            message: "web.search arguments do not match the input schema",
          };
        }
        try {
          const result = await port.search(args);
          return {
            status: "completed",
            output: result as unknown as JsonValue,
            receipt: { count: result.results.length },
          };
        } catch (error) {
          return adapterFailure(error);
        }
      }

      if (invocation.capability === "web.read") {
        const args = parseReadArguments(invocation.arguments);
        if (args === undefined) {
          return {
            status: "failed",
            code: "invalid_arguments",
            message: "web.read arguments do not match the input schema",
          };
        }
        try {
          const result = await port.read(args);
          return {
            status: "completed",
            output: result as unknown as JsonValue,
            receipt: { url: result.url },
          };
        } catch (error) {
          return adapterFailure(error);
        }
      }

      return {
        status: "failed",
        code: "unknown_capability",
        message: `Unknown capability: ${invocation.capability}`,
      };
    },
  };
}

function parseSearchArguments(
  args: unknown,
): { query: string; limit: number } | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "query" && key !== "limit")) {
    return undefined;
  }
  const { query, limit } = record;
  if (typeof query !== "string" || query.length === 0) {
    return undefined;
  }
  if (limit === undefined) {
    return { query, limit: WEB_SEARCH_DEFAULT_LIMIT };
  }
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
    return undefined;
  }
  return { query, limit: Math.min(limit, WEB_SEARCH_MAX_RESULTS) };
}

function parseReadArguments(args: unknown): { url: string } | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "url")) {
    return undefined;
  }
  const { url } = record;
  if (typeof url !== "string" || url.length === 0) {
    return undefined;
  }
  return { url };
}

function adapterFailure(error: unknown): {
  readonly status: "failed";
  readonly code: "adapter_error";
  readonly message: string;
} {
  const message = error instanceof Error ? error.message : "Web adapter failed";
  return { status: "failed", code: "adapter_error", message };
}
