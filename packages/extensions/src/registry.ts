import type { CapabilityDescriptor, CapabilityTrait, JsonObject } from "@oren/kernel";
import type { OrenExtension } from "./sdk.js";

const capabilityTraits: ReadonlySet<CapabilityTrait> = new Set([
  "read_only",
  "replay_safe",
  "reversible",
  "external_side_effect",
  "uses_user_identity",
  "uses_sensitive_data",
  "billable",
  "destructive",
]);

function cloneJson(value: JsonObject): JsonObject {
  return structuredClone(value);
}

function cloneDescriptor(descriptor: CapabilityDescriptor): CapabilityDescriptor {
  return {
    ...descriptor,
    inputSchema: cloneJson(descriptor.inputSchema),
    outputSchema: cloneJson(descriptor.outputSchema),
    permissionRequirements: [...descriptor.permissionRequirements],
    traits: [...descriptor.traits],
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDescriptor(descriptor: CapabilityDescriptor, extensionId: string): void {
  if (descriptor.extensionId !== extensionId) {
    throw new Error(`Capability ${descriptor.name} has the wrong extensionId`);
  }
  if (typeof descriptor.name !== "string" || !descriptor.name) {
    throw new Error("Capability has an invalid name");
  }
  if (typeof descriptor.description !== "string" || !descriptor.description) {
    throw new Error(`Capability ${descriptor.name} has an invalid description`);
  }
  if (!isJsonObject(descriptor.inputSchema)) {
    throw new Error(`Capability ${descriptor.name} has an invalid input schema`);
  }
  if (!isJsonObject(descriptor.outputSchema)) {
    throw new Error(`Capability ${descriptor.name} has an invalid output schema`);
  }
  if (!Number.isFinite(descriptor.timeoutMs) || descriptor.timeoutMs <= 0) {
    throw new Error(`Capability ${descriptor.name} has an invalid timeout`);
  }
  if (!Array.isArray(descriptor.permissionRequirements)
    || descriptor.permissionRequirements.some((permission) => typeof permission !== "string" || !permission)
    || new Set(descriptor.permissionRequirements).size !== descriptor.permissionRequirements.length) {
    throw new Error(`Capability ${descriptor.name} has invalid permission requirements`);
  }
  if (!Array.isArray(descriptor.traits)
    || descriptor.traits.some((trait) => !capabilityTraits.has(trait))
    || new Set(descriptor.traits).size !== descriptor.traits.length) {
    throw new Error(`Capability ${descriptor.name} has invalid traits`);
  }
  if (typeof descriptor.cancellable !== "boolean") {
    throw new Error(`Capability ${descriptor.name} has an invalid cancellable flag`);
  }
}

export class ExtensionRegistry {
  private readonly extensions = new Map<string, OrenExtension>();
  private readonly capabilities = new Map<string, CapabilityDescriptor>();

  public register(extension: OrenExtension): void {
    const { manifest } = extension;
    if (manifest.protocolVersion !== 1) {
      throw new Error(`Unsupported extension protocol: ${manifest.protocolVersion}`);
    }
    if (!manifest.id) {
      throw new Error("Extension has an invalid id");
    }
    if (!manifest.version) {
      throw new Error(`Extension ${manifest.id} has an invalid version`);
    }
    if (this.extensions.has(manifest.id)) {
      throw new Error(`Duplicate extension: ${manifest.id}`);
    }
    if (!Array.isArray(manifest.capabilities) || !Array.isArray(manifest.eventSources)) {
      throw new Error(`Extension ${manifest.id} has an invalid manifest`);
    }
    const eventSources = new Set<string>();
    for (const eventSource of manifest.eventSources) {
      if (typeof eventSource !== "string" || !eventSource) {
        throw new Error(`Extension ${manifest.id} has an invalid event source`);
      }
      if (eventSources.has(eventSource)) {
        throw new Error(`Duplicate event source: ${eventSource}`);
      }
      eventSources.add(eventSource);
    }

    const descriptors = manifest.capabilities.map(cloneDescriptor);
    const names = new Set<string>();
    for (const descriptor of descriptors) {
      validateDescriptor(descriptor, manifest.id);
      if (names.has(descriptor.name) || this.capabilities.has(descriptor.name)) {
        throw new Error(`Duplicate capability: ${descriptor.name}`);
      }
      names.add(descriptor.name);
    }

    for (const descriptor of descriptors) {
      this.capabilities.set(descriptor.name, descriptor);
    }
    this.extensions.set(manifest.id, extension);
  }

  public listCapabilities(): readonly CapabilityDescriptor[] {
    return [...this.capabilities.values()].map(cloneDescriptor);
  }

  public resolve(name: string): { readonly descriptor: CapabilityDescriptor; readonly extension: OrenExtension } {
    const descriptor = this.capabilities.get(name);
    if (!descriptor) {
      throw new Error(`Unknown capability: ${name}`);
    }
    const extension = this.extensions.get(descriptor.extensionId);
    if (!extension) {
      throw new Error(`Inactive extension: ${descriptor.extensionId}`);
    }
    return { descriptor: cloneDescriptor(descriptor), extension };
  }
}
