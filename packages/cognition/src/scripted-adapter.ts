import type {
  CognitionCapabilityPort,
  CognitionEvent,
  CognitionHandlers,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
  StreamingCognitionPort,
} from "./types.js";

export type CognitionScript = (
  frame: LifeFrame,
  capabilityPort: CognitionCapabilityPort,
  signal: AbortSignal,
) => Promise<CognitionOutcome>;

export class ScriptedCognitionAdapter implements CognitionPort {
  public constructor(private readonly script: CognitionScript) {}

  public async run(
    frame: LifeFrame,
    capabilityPort: CognitionCapabilityPort,
    signal: AbortSignal,
  ): Promise<CognitionOutcome> {
    return signal.aborted
      ? { kind: "aborted", usage: { totalTokens: 0 } }
      : this.script(frame, capabilityPort, signal);
  }
}

export type StreamingCognitionScript = (
  frame: LifeFrame,
  handlers: CognitionHandlers,
  signal: AbortSignal,
) => AsyncIterable<CognitionEvent>;

export class ScriptedStreamingCognitionAdapter implements StreamingCognitionPort {
  public constructor(private readonly script: StreamingCognitionScript) {}

  public stream(
    frame: LifeFrame,
    handlers: CognitionHandlers,
    signal: AbortSignal,
  ): AsyncIterable<CognitionEvent> {
    if (signal.aborted) {
      return (async function* (): AsyncIterable<CognitionEvent> {
        yield {
          type: "episode.aborted",
          usage: { totalTokens: 0 },
        };
      })();
    }
    return this.script(frame, handlers, signal);
  }
}
