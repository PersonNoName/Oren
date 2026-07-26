import type { ChannelPort, DeliverInput, DeliverResult, InboxMessage } from "./types.js";

export class PanelInboxAdapter implements ChannelPort {
  public readonly messages: InboxMessage[] = [];

  public constructor(private readonly now: () => string) {}

  public async deliver(input: DeliverInput): Promise<DeliverResult> {
    if (input.text.length === 0) {
      return { ok: false, code: "empty_text", message: "text must not be empty" };
    }

    const deliveredAt = this.now();
    this.messages.push({ ...input, deliveredAt });
    return { ok: true, deliveredAt };
  }
}
