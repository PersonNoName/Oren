import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "../src/index.js";

describe("canonicalizeJson", () => {
  it("copies accepted JSON into deeply frozen inert values with null-prototype objects", () => {
    const source = {
      nested: { value: 1 },
      items: [{ enabled: true }, null],
    };

    const result = canonicalizeJson(source);

    expect(result).toMatchObject({ ok: true, value: source });
    if (!result.ok) throw new Error("expected valid JSON");
    expect(result.value).not.toBe(source);
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    const value = result.value as {
      readonly nested: object;
      readonly items: readonly object[];
    };
    expect(Object.getPrototypeOf(value.nested)).toBeNull();
    expect(Object.getPrototypeOf(value.items)).toBe(Array.prototype);
    expect(Object.getPrototypeOf(value.items[0])).toBeNull();
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.items)).toBe(true);
    expect(Object.isFrozen(value.items[0])).toBe(true);
  });

  it.each([
    {
      name: "an enumerable accessor",
      value: () => {
        const object = {};
        Object.defineProperty(object, "value", {
          enumerable: true,
          get: () => {
            throw new Error("must not invoke getter");
          },
        });
        return object;
      },
    },
    {
      name: "a non-enumerable property",
      value: () => {
        const object = {};
        Object.defineProperty(object, "hidden", { value: true });
        return object;
      },
    },
    {
      name: "an own serialization hook",
      value: () => {
        const object = { value: 1 };
        Object.defineProperty(object, "toJSON", {
          value: () => ({ value: 2 }),
        });
        return object;
      },
    },
    {
      name: "an inherited serialization hook",
      value: () => Object.create({ toJSON: () => ({ value: 1 }) }),
    },
    { name: "a symbol property", value: () => ({ [Symbol("hidden")]: true }) },
    { name: "a sparse array", value: () => Array(1) },
    {
      name: "an array with an extra property",
      value: () => Object.assign([1], { extra: true }),
    },
    { name: "a class instance", value: () => new (class Example { public value = 1; })() },
    { name: "a cycle", value: () => {
      const object: Record<string, unknown> = {};
      object.self = object;
      return object;
    } },
    { name: "BigInt", value: () => 1n },
    { name: "undefined", value: () => undefined },
    { name: "a nonfinite number", value: () => Number.POSITIVE_INFINITY },
  ])("rejects $name without throwing", ({ value }) => {
    expect(() => canonicalizeJson(value())).not.toThrow();
    expect(canonicalizeJson(value())).toEqual({ ok: false });
  });

  it("rejects hostile and transparent proxies without invoking their traps", () => {
    let trapCalls = 0;
    const hostile = new Proxy({}, {
      getPrototypeOf: () => {
        trapCalls += 1;
        throw new Error("must not inspect proxy");
      },
    });
    const transparent = new Proxy({ value: 1 }, {});

    expect(canonicalizeJson(hostile)).toEqual({ ok: false });
    expect(canonicalizeJson(transparent)).toEqual({ ok: false });
    expect(trapCalls).toBe(0);
  });
});
