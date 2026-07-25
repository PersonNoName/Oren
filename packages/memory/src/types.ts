import type { EventEnvelope, MemoryKind } from "@oren/kernel";

export interface MemoryEntry {
  readonly memoryId: string;
  readonly orenId: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly sourceEventId: string;
  readonly occurredAt: string;
  readonly confidence: number | null;
  readonly reviewCondition: string | null;
  readonly threadId: string | null;
  readonly recallability: "active" | "lowered";
}

export interface RecallQuery {
  readonly orenId: string;
  readonly text?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly threadId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly includeLowered?: boolean;
}

export interface EventRecord {
  readonly sequence: number;
  readonly envelope: EventEnvelope;
}

export interface MemoryPort {
  project(records: readonly EventRecord[]): Promise<void>;
  recall(query: RecallQuery): Promise<readonly MemoryEntry[]>;
  rebuild(loadAll: () => readonly EventRecord[]): Promise<void>;
  cursor(): number;
}

export interface EmbeddingPort {
  embed(texts: readonly string[]): Promise<ReadonlyArray<readonly number[]>>;
}
