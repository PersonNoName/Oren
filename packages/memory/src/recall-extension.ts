import type { OrenExtension } from "@oren/extensions";
import type { JsonValue, MemoryKind } from "@oren/kernel";
import type { MemoryPort, RecallQuery } from "./types.js";

const MEMORY_KIND_VALUES = [
  "user_statement",
  "external_fact",
  "oren_judgment",
  "oren_expression",
] as const;
const MEMORY_KINDS = new Set<string>(MEMORY_KIND_VALUES);

export function createMemoryRecallExtension(memory: MemoryPort): OrenExtension {
  return {
    manifest: {
      id: "memory",
      version: "1.0.0",
      protocolVersion: 1,
      eventSources: [],
      capabilities: [{
        extensionId: "memory",
        name: "memory.recall",
        description: "召回过往记忆：可按语义文本、类型、线索与时间过滤；"
          + "默认不包含已降低可召回性的条目（includeLowered 可显式包含）。",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "语义查询文本" },
            kinds: {
              type: "array",
              items: { type: "string", enum: [...MEMORY_KIND_VALUES] },
            },
            threadId: { type: "string" },
            since: { type: "string", description: "ISO 时间下界" },
            until: { type: "string", description: "ISO 时间上界" },
            limit: { type: "number" },
            includeLowered: { type: "boolean" },
          },
          additionalProperties: false,
        },
        outputSchema: { type: "array" },
        permissionRequirements: [],
        traits: ["read_only", "replay_safe"],
        cancellable: true,
        timeoutMs: 5_000,
      }],
    },
    async activate() {},
    async deactivate() {},
    async invoke(invocation) {
      const query = parseQuery(invocation.orenId, invocation.arguments);
      if (query === undefined) {
        return {
          status: "failed",
          code: "invalid_arguments",
          message: "memory.recall arguments do not match the input schema",
        };
      }
      const entries = await memory.recall(query);
      return {
        status: "completed",
        output: entries as unknown as JsonValue,
        receipt: { count: entries.length },
      };
    },
  };
}

function parseQuery(orenId: string, args: unknown): RecallQuery | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const allowed = new Set([
    "text",
    "kinds",
    "threadId",
    "since",
    "until",
    "limit",
    "includeLowered",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  const { text, kinds, threadId, since, until, limit, includeLowered } = record;
  if (text !== undefined && typeof text !== "string") return undefined;
  if (kinds !== undefined && (
    !Array.isArray(kinds)
    || kinds.some((kind) => typeof kind !== "string" || !MEMORY_KINDS.has(kind))
  )) {
    return undefined;
  }
  if (threadId !== undefined && typeof threadId !== "string") return undefined;
  if (since !== undefined && typeof since !== "string") return undefined;
  if (until !== undefined && typeof until !== "string") return undefined;
  if (limit !== undefined
    && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)) {
    return undefined;
  }
  if (includeLowered !== undefined && typeof includeLowered !== "boolean") return undefined;
  return {
    orenId,
    ...(text !== undefined ? { text } : {}),
    ...(kinds !== undefined ? { kinds: kinds as readonly MemoryKind[] } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(includeLowered !== undefined ? { includeLowered } : {}),
  };
}
