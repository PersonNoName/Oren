import { types as utilTypes } from "node:util";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type CanonicalJsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false };

const INVALID_JSON = Object.freeze({ ok: false } as const);

function hasToJsonHook(value: object): boolean {
  let current: object | null = value;
  while (current !== null) {
    if (Object.getOwnPropertyDescriptor(current, "toJSON") !== undefined) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

function canonicalizeArray(
  value: unknown[],
  seen: Set<object>,
): readonly JsonValue[] | undefined {
  if (Object.getPrototypeOf(value) !== Array.prototype || hasToJsonHook(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || keys.length !== value.length + 1
    || !keys.includes("length")
  ) {
    return undefined;
  }
  const canonical: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      return undefined;
    }
    const item = canonicalizeValue(descriptor.value, seen);
    if (item === undefined) return undefined;
    canonical.push(item);
  }
  return Object.freeze(canonical);
}

function canonicalizeObject(
  value: object,
  seen: Set<object>,
): JsonObject | undefined {
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || hasToJsonHook(value)
  ) {
    return undefined;
  }
  const canonical = Object.create(null) as Record<string, JsonValue>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      return undefined;
    }
    const item = canonicalizeValue(descriptor.value, seen);
    if (item === undefined) return undefined;
    Object.defineProperty(canonical, key, {
      value: item,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(canonical);
}

function canonicalizeValue(value: unknown, seen: Set<object>): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || utilTypes.isProxy(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    return Array.isArray(value)
      ? canonicalizeArray(value, seen)
      : canonicalizeObject(value, seen);
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeJson(value: unknown): CanonicalJsonResult {
  try {
    const canonical = canonicalizeValue(value, new Set());
    return canonical === undefined
      ? INVALID_JSON
      : Object.freeze({ ok: true, value: canonical });
  } catch {
    return INVALID_JSON;
  }
}
