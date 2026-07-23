import type {
  CapabilityDescriptor,
  CapabilityInvocation,
  CapabilityResult,
  JsonObject,
} from "@oren/kernel";

export interface ExtensionContext {
  readonly extensionId: string;
  reportProgress(invocationId: string, message: string): void;
  emitObservation(source: string, payload: JsonObject): void;
}

export interface OrenExtension {
  readonly manifest: {
    readonly id: string;
    readonly version: string;
    readonly protocolVersion: 1;
    readonly capabilities: readonly CapabilityDescriptor[];
    readonly eventSources: readonly string[];
  };
  activate(context: ExtensionContext): Promise<void>;
  deactivate(): Promise<void>;
  invoke(invocation: CapabilityInvocation, signal: AbortSignal): Promise<CapabilityResult>;
  query?(effectId: string, signal: AbortSignal): Promise<CapabilityResult>;
  cancel?(effectId: string, signal: AbortSignal): Promise<void>;
}
