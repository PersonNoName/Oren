import type {
  CognitionCapabilityPort,
  CognitionOutcome,
  CognitionPort,
  LifeFrame,
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
