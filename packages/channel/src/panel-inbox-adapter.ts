import type { ChannelPort, DeliverInput, DeliverResult, InboxMessage } from "./types.js";
import type {
  ForegroundSpeechPort,
  LiveSpeechMessage,
  SpeechEvent,
  SpeechStatus,
} from "./speech.js";

export class PanelInboxAdapter implements ChannelPort, ForegroundSpeechPort {
  public readonly messages: InboxMessage[] = [];
  public readonly liveMessages = new Map<string, LiveSpeechMessage>();
  private readonly speechListeners = new Set<(event: SpeechEvent) => void>();

  public constructor(private readonly now: () => string) {}

  public async deliver(input: DeliverInput): Promise<DeliverResult> {
    if (input.text.length === 0) {
      return { ok: false, code: "empty_text", message: "text must not be empty" };
    }

    const existing = this.messages.find((message) => message.deliveryId === input.deliveryId);
    if (existing) {
      return { ok: true, deliveredAt: existing.deliveredAt };
    }

    const deliveredAt = this.now();
    this.messages.push({ ...input, deliveredAt });
    return { ok: true, deliveredAt };
  }

  public subscribeSpeech(listener: (event: SpeechEvent) => void): () => void {
    this.speechListeners.add(listener);
    return () => this.speechListeners.delete(listener);
  }

  public async startSpeech(input: {
    readonly episodeId: string;
    readonly messageId: string;
  }): Promise<void> {
    if (!this.liveMessages.has(input.messageId)) {
      this.liveMessages.set(input.messageId, {
        ...input,
        text: "",
        status: "streaming",
      });
    }
    this.publish({ type: "speech.started", ...input });
  }

  public async appendSpeech(input: {
    readonly messageId: string;
    readonly text: string;
  }): Promise<void> {
    const current = this.liveMessages.get(input.messageId);
    if (!current || current.status !== "streaming") {
      throw new Error(`Unknown active speech message: ${input.messageId}`);
    }
    this.liveMessages.set(input.messageId, {
      ...current,
      text: current.text + input.text,
    });
    this.publish({ type: "speech.delta", ...input });
  }

  public async completeSpeech(input: {
    readonly messageId: string;
    readonly status: SpeechStatus;
  }): Promise<void> {
    const current = this.liveMessages.get(input.messageId);
    if (!current) {
      throw new Error(`Unknown speech message: ${input.messageId}`);
    }
    this.liveMessages.set(input.messageId, { ...current, status: input.status });
    this.publish({ type: "speech.completed", ...input });
  }

  private publish(event: SpeechEvent): void {
    for (const listener of this.speechListeners) listener(event);
  }
}
