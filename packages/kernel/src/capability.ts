import type { EffectId, GrantId, OrenId } from "./ids.js";
import type { JsonObject, JsonValue } from "./json.js";

export type CapabilityTrait =
  | "read_only"
  | "replay_safe"
  | "reversible"
  | "external_side_effect"
  | "uses_user_identity"
  | "uses_sensitive_data"
  | "billable"
  | "destructive";

export interface CapabilityDescriptor {
  readonly extensionId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly permissionRequirements: readonly string[];
  readonly traits: readonly CapabilityTrait[];
  readonly cancellable: boolean;
  readonly timeoutMs: number;
}

export interface CapabilityInvocation {
  readonly effectId: EffectId;
  readonly orenId: OrenId;
  readonly capability: string;
  readonly arguments: JsonObject;
  readonly grantIds: readonly GrantId[];
  readonly stateVersion: number;
  readonly deadline: string;
}

export type CapabilityResult =
  | { readonly status: "completed"; readonly output: JsonValue; readonly receipt: JsonObject }
  | { readonly status: "failed"; readonly code: string; readonly message: string }
  | { readonly status: "uncertain"; readonly message: string };

export function isImmediateCapability(descriptor: CapabilityDescriptor): boolean {
  const traits = new Set(descriptor.traits);
  return traits.has("read_only")
    && traits.has("replay_safe")
    && !traits.has("external_side_effect")
    && !traits.has("uses_user_identity")
    && !traits.has("destructive");
}
