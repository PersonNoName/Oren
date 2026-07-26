export type SpeechStatus = "complete" | "interrupted";

export type SpeechEvent =
  | {
      readonly type: "speech.started";
      readonly episodeId: string;
      readonly messageId: string;
    }
  | {
      readonly type: "speech.delta";
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly type: "speech.completed";
      readonly messageId: string;
      readonly status: SpeechStatus;
    };

export interface ForegroundSpeechPort {
  startSpeech(
    input: Omit<Extract<SpeechEvent, { type: "speech.started" }>, "type">,
  ): Promise<void>;
  appendSpeech(
    input: Omit<Extract<SpeechEvent, { type: "speech.delta" }>, "type">,
  ): Promise<void>;
  completeSpeech(
    input: Omit<Extract<SpeechEvent, { type: "speech.completed" }>, "type">,
  ): Promise<void>;
}

export interface LiveSpeechMessage {
  readonly episodeId: string;
  readonly messageId: string;
  readonly text: string;
  readonly status: "streaming" | SpeechStatus;
}
