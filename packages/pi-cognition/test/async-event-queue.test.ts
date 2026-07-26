import { describe, expect, it } from "vitest";
import { AsyncEventQueue } from "../src/async-event-queue.js";

describe("AsyncEventQueue", () => {
  it("delivers buffered and pending values in push order before completion", async () => {
    const queue = new AsyncEventQueue<number>();
    queue.push(1);
    const iterator = queue[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 });

    const pending = iterator.next();
    queue.push(2);
    await expect(pending).resolves.toEqual({ done: false, value: 2 });

    queue.end();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects pending and future reads after failure", async () => {
    const queue = new AsyncEventQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.fail(new Error("stream failed"));

    await expect(pending).rejects.toThrow("stream failed");
    await expect(iterator.next()).rejects.toThrow("stream failed");
  });
});
