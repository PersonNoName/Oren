import type { DatabaseSync } from "node:sqlite";
import type { EventEnvelope, MemoryKind } from "@oren/kernel";
import type {
  EmbeddingPort,
  EventRecord,
  MemoryEntry,
  MemoryPort,
  RecallQuery,
} from "./types.js";

const DEFAULT_LIMIT = 10;
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;
const AUTO_JUDGMENT_CONFIDENCE = 0.5;

export interface SqliteMemoryIndexOptions {
  readonly embedder?: EmbeddingPort;
  readonly now?: () => number;
}

interface ScoredEntry {
  readonly entry: MemoryEntry;
  readonly score: number;
}

export class SqliteMemoryIndex implements MemoryPort {
  private readonly embedder: EmbeddingPort | undefined;
  private readonly now: () => number;
  private cursorValue: number;

  public constructor(
    private readonly db: DatabaseSync,
    options: SqliteMemoryIndexOptions = {},
  ) {
    this.embedder = options.embedder;
    this.now = options.now ?? Date.now;
    this.ensureSchema();
    this.cursorValue = this.loadCursor();
  }

  public cursor(): number {
    return this.cursorValue;
  }

  public async project(records: readonly EventRecord[]): Promise<void> {
    for (const record of records) {
      if (record.sequence <= this.cursorValue) continue;
      await this.projectEnvelope(record.envelope);
      this.cursorValue = record.sequence;
      this.saveCursor();
    }
  }

  public async rebuild(loadAll: () => readonly EventRecord[]): Promise<void> {
    this.db.prepare("DELETE FROM memory_entries").run();
    this.cursorValue = 0;
    this.saveCursor();
    await this.project(loadAll());
  }

  public async recall(query: RecallQuery): Promise<readonly MemoryEntry[]> {
    const limit = query.limit !== undefined
      && Number.isSafeInteger(query.limit)
      && query.limit > 0
      ? query.limit
      : DEFAULT_LIMIT;
    const conditions = ["oren_id = ?"];
    const parameters: Array<string | number> = [query.orenId];
    if (query.includeLowered !== true) {
      conditions.push("recallability = 'active'");
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      conditions.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`);
      parameters.push(...query.kinds);
    }
    if (query.threadId !== undefined) {
      conditions.push("thread_id = ?");
      parameters.push(query.threadId);
    }
    if (query.since !== undefined) {
      conditions.push("occurred_at >= ?");
      parameters.push(query.since);
    }
    if (query.until !== undefined) {
      conditions.push("occurred_at <= ?");
      parameters.push(query.until);
    }
    const rows = this.db.prepare(`
      SELECT memory_id, oren_id, kind, text, source_event_id, occurred_at,
             confidence, review_condition, thread_id, recallability, embedding_json
      FROM memory_entries
      WHERE ${conditions.join(" AND ")}
    `).all(...parameters);

    const queryVector = query.text !== undefined && this.embedder !== undefined
      ? (await this.embedder.embed([query.text]))[0]
      : undefined;

    const scored: ScoredEntry[] = rows.map((row) => {
      const entry = rowToEntry(row);
      const embedding = row.embedding_json === null
        ? undefined
        : JSON.parse(String(row.embedding_json)) as number[];
      let relevance: number;
      if (query.text === undefined) {
        relevance = 1;
      } else if (queryVector !== undefined && embedding !== undefined) {
        relevance = cosine(queryVector, embedding);
      } else {
        relevance = entry.text.includes(query.text) ? 1 : 0;
      }
      return { entry, score: relevance * this.recencyFactor(entry.occurredAt) };
    });

    scored.sort((left, right) =>
      right.score - left.score
      || right.entry.occurredAt.localeCompare(left.entry.occurredAt)
      || left.entry.memoryId.localeCompare(right.entry.memoryId));
    return scored.slice(0, limit).map(({ entry }) => entry);
  }

  private recencyFactor(occurredAt: string): number {
    const age = Math.max(0, this.now() - Date.parse(occurredAt));
    return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
  }

  private async projectEnvelope(envelope: EventEnvelope): Promise<void> {
    const { payload } = envelope;
    switch (payload.type) {
      case "UserMessageReceived":
        await this.upsertEntry({
          memoryId: `mem:${envelope.eventId}`,
          orenId: envelope.orenId,
          kind: "user_statement",
          text: payload.text,
          sourceEventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
          confidence: null,
          reviewCondition: null,
          threadId: null,
          recallability: "active",
        });
        return;
      case "ThreadAdvanced":
        await this.upsertEntry({
          memoryId: `mem:${envelope.eventId}`,
          orenId: envelope.orenId,
          kind: "oren_judgment",
          text: `线索「${payload.threadId}」推进：${payload.summary}`,
          sourceEventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
          confidence: AUTO_JUDGMENT_CONFIDENCE,
          reviewCondition: null,
          threadId: payload.threadId,
          recallability: "active",
        });
        return;
      case "CognitionCompleted": {
        for (const [proposalIndex, proposal] of payload.proposals.entries()) {
          if (proposal.type !== "ExpressToUser") continue;
          await this.upsertEntry({
            memoryId: `mem:${envelope.eventId}:express:${proposalIndex}`,
            orenId: envelope.orenId,
            kind: "oren_expression",
            text: proposal.text,
            sourceEventId: envelope.eventId,
            occurredAt: envelope.occurredAt,
            confidence: null,
            reviewCondition: null,
            threadId: null,
            recallability: "active",
          });
        }
        return;
      }
      case "MemoryRemembered":
        await this.upsertEntry({
          memoryId: payload.memoryId,
          orenId: envelope.orenId,
          kind: payload.kind,
          text: payload.text,
          sourceEventId: envelope.eventId,
          occurredAt: envelope.occurredAt,
          confidence: payload.confidence ?? null,
          reviewCondition: payload.reviewCondition ?? null,
          threadId: payload.threadId ?? null,
          recallability: "active",
        });
        return;
      case "BeliefRevised": {
        const existing = this.db.prepare(`
          SELECT text FROM memory_entries WHERE memory_id = ? AND oren_id = ?
        `).get(payload.memoryId, envelope.orenId);
        if (!existing) return; // 未知引用：入史不投影
        const text = payload.revisedText ?? String(existing.text);
        const embedding = await this.embeddingJson(text);
        this.db.prepare(`
          UPDATE memory_entries
          SET text = ?, confidence = ?, embedding_json = ?
          WHERE memory_id = ? AND oren_id = ?
        `).run(text, payload.confidence, embedding, payload.memoryId, envelope.orenId);
        return;
      }
      case "MemoryForgotten":
        this.db.prepare(`
          UPDATE memory_entries SET recallability = 'lowered'
          WHERE memory_id = ? AND oren_id = ?
        `).run(payload.memoryId, envelope.orenId);
        return;
      default:
        return;
    }
  }

  private async upsertEntry(entry: MemoryEntry): Promise<void> {
    const embedding = await this.embeddingJson(entry.text);
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_entries(
        memory_id, oren_id, kind, text, source_event_id, occurred_at,
        confidence, review_condition, thread_id, recallability, embedding_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.memoryId,
      entry.orenId,
      entry.kind,
      entry.text,
      entry.sourceEventId,
      entry.occurredAt,
      entry.confidence,
      entry.reviewCondition,
      entry.threadId,
      entry.recallability,
      embedding,
    );
  }

  private async embeddingJson(text: string): Promise<string | null> {
    if (this.embedder === undefined) return null;
    const [vector] = await this.embedder.embed([text]);
    return vector === undefined ? null : JSON.stringify(vector);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        memory_id TEXT PRIMARY KEY,
        oren_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        confidence REAL,
        review_condition TEXT,
        thread_id TEXT,
        recallability TEXT NOT NULL DEFAULT 'active'
          CHECK(recallability IN ('active', 'lowered')),
        embedding_json TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_entries_by_oren
      ON memory_entries(oren_id, occurred_at);
      CREATE TABLE IF NOT EXISTS memory_projection_cursor (
        id TEXT PRIMARY KEY CHECK(id = 'global'),
        last_sequence INTEGER NOT NULL
      );
    `);
  }

  private loadCursor(): number {
    const row = this.db.prepare(`
      SELECT last_sequence FROM memory_projection_cursor WHERE id = 'global'
    `).get();
    return row ? Number(row.last_sequence) : 0;
  }

  private saveCursor(): void {
    this.db.prepare(`
      INSERT INTO memory_projection_cursor(id, last_sequence) VALUES ('global', ?)
      ON CONFLICT(id) DO UPDATE SET last_sequence = excluded.last_sequence
    `).run(this.cursorValue);
  }
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    memoryId: String(row.memory_id),
    orenId: String(row.oren_id),
    kind: String(row.kind) as MemoryKind,
    text: String(row.text),
    sourceEventId: String(row.source_event_id),
    occurredAt: String(row.occurred_at),
    confidence: row.confidence === null ? null : Number(row.confidence),
    reviewCondition: row.review_condition === null ? null : String(row.review_condition),
    threadId: row.thread_id === null ? null : String(row.thread_id),
    recallability: String(row.recallability) === "lowered" ? "lowered" : "active",
  };
}

export function cosine(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    normLeft += left[index]! * left[index]!;
    normRight += right[index]! * right[index]!;
  }
  if (normLeft === 0 || normRight === 0) return 0;
  return dot / Math.sqrt(normLeft * normRight);
}
