import type { ChannelPort, DeliverInput, DeliverResult } from "./types.js";

type ScriptedHandlers = {
  deliver?: (input: DeliverInput) => Promise<DeliverResult> | DeliverResult;
};

export class ScriptedChannelAdapter implements ChannelPort {
  public readonly calls: DeliverInput[] = [];

  public constructor(private readonly handlers: ScriptedHandlers = {}) {}

  public async deliver(input: DeliverInput): Promise<DeliverResult> {
    this.calls.push(input);

    if (this.handlers.deliver) {
      return this.handlers.deliver(input);
    }

    return { ok: true, deliveredAt: new Date().toISOString() };
  }
}
