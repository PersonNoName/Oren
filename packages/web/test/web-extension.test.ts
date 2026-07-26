import { describe, expect, it } from "vitest";
import { isImmediateCapability, type JsonObject } from "@oren/kernel";
import {
  createWebExtension,
  ScriptedWebAdapter,
  type WebPort,
} from "@oren/web";

function makeInvocation(
  capability: "web.search" | "web.read",
  args: JsonObject,
) {
  return {
    effectId: "ef1",
    orenId: "oren-1",
    capability,
    arguments: args,
    grantIds: [],
    stateVersion: 1,
    deadline: "2026-07-26T00:00:01.000Z",
  };
}

function makeExtension(port: WebPort) {
  return createWebExtension(port);
}

describe("createWebExtension", () => {
  it("exposes web.search and web.read as immediate billable capabilities", () => {
    const extension = makeExtension(new ScriptedWebAdapter({
      search: () => ({ results: [] }),
      read: () => ({ url: "https://example.com", text: "" }),
    }));
    const names = extension.manifest.capabilities.map((descriptor) => descriptor.name);
    expect(names).toEqual(["web.search", "web.read"]);
    for (const descriptor of extension.manifest.capabilities) {
      expect(descriptor.permissionRequirements).toEqual([]);
      expect(descriptor.traits).toEqual(["read_only", "replay_safe", "billable"]);
      expect(descriptor.timeoutMs).toBe(10_000);
      expect(isImmediateCapability(descriptor)).toBe(true);
    }
  });

  it("rejects web.search without a query", async () => {
    const extension = makeExtension(new ScriptedWebAdapter({
      search: () => ({ results: [] }),
      read: () => ({ url: "https://example.com", text: "" }),
    }));
    const result = await extension.invoke(
      makeInvocation("web.search", { limit: 3 }),
      new AbortController().signal,
    );
    expect(result).toEqual({
      status: "failed",
      code: "invalid_arguments",
      message: "web.search arguments do not match the input schema",
    });
  });

  it("returns search results on success", async () => {
    const extension = makeExtension(new ScriptedWebAdapter({
      search: () => ({
        results: [{
          title: "Example",
          url: "https://example.com",
          snippet: "snippet text",
        }],
      }),
      read: () => ({ url: "https://example.com", text: "" }),
    }));
    const result = await extension.invoke(
      makeInvocation("web.search", { query: "example" }),
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({
        results: [{
          title: "Example",
          url: "https://example.com",
          snippet: "snippet text",
        }],
      });
    }
  });

  it("returns read text on success", async () => {
    const extension = makeExtension(new ScriptedWebAdapter({
      search: () => ({ results: [] }),
      read: () => ({ url: "https://example.com", title: "Example", text: "page body" }),
    }));
    const result = await extension.invoke(
      makeInvocation("web.read", { url: "https://example.com" }),
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({
        url: "https://example.com/",
        title: "Example",
        text: "page body",
      });
    }
  });

  it("returns failed when the adapter rejects an unsafe read URL", async () => {
    const extension = makeExtension(new ScriptedWebAdapter({
      search: () => ({ results: [] }),
      read: () => ({ url: "http://127.0.0.1/", text: "secret" }),
    }));
    const result = await extension.invoke(
      makeInvocation("web.read", { url: "http://127.0.0.1/" }),
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.code).toBe("adapter_error");
      expect(result.message).toMatch(/private|local|not allowed/i);
    }
  });
});
