import type { LlmCompleter } from "./types.js";

/**
 * Lazy-loads @earendil-works/pi-ai so tests without the package still load the CLI for fake mode.
 */
export class PiAiCompleter implements LlmCompleter {
  constructor(private readonly modelSpec: string) {}

  async complete(input: { system: string; user: string }): Promise<string> {
    const pi = await import("@earendil-works/pi-ai");
    const { provider, modelId } = parseModelSpec(this.modelSpec);

    if (typeof pi.getModel !== "function") {
      throw new Error("pi-ai getModel not found");
    }

    const model = pi.getModel(provider, modelId);

    if (typeof pi.completeSimple === "function") {
      const result = await pi.completeSimple(model, {
        system: input.system,
        messages: [{ role: "user", content: input.user }],
      });
      const text = result.text ?? result.content ?? "";
      if (!text.trim()) throw new Error("pi-ai returned empty completion");
      return text;
    }

    if (typeof pi.streamSimple !== "function") {
      throw new Error(
        "pi-ai API not found (expected getModel + streamSimple or completeSimple)",
      );
    }

    const stream = pi.streamSimple(
      model,
      {
        systemPrompt: input.system,
        messages: [{ role: "user", content: input.user }],
      },
      {},
    );

    let out = "";
    for await (const ev of stream) {
      if (typeof ev.delta === "string") out += ev.delta;
      else if (typeof ev.text === "string") out += ev.text;
    }

    if (!out.trim() && typeof stream.result === "function") {
      const r = await stream.result();
      out = r?.text ?? "";
    }

    if (!out.trim()) {
      throw new Error("pi-ai stream produced empty text");
    }
    return out;
  }
}

export function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const idx = spec.indexOf(":");
  if (idx <= 0) {
    return { provider: "anthropic", modelId: spec };
  }
  return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}
