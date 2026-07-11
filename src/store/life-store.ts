import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lifePaths, type LifePaths } from "../paths.js";
import {
  SCHEMA_VERSION,
  defaultAffect,
  defaultConfig,
  defaultTaste,
  type Affect,
  type Config,
  type LifeState,
  type Meta,
  type StreamEvent,
  type Taste,
  type Thread,
} from "../types.js";
import { atomicWriteJson } from "./atomic-write.js";

export class NotInitializedError extends Error {
  readonly code = 3 as const;
  constructor(message = "Oren life store is not initialized") {
    super(message);
    this.name = "NotInitializedError";
  }
}

export class SchemaMismatchError extends Error {
  readonly code = 3 as const;
  constructor(message: string) {
    super(message);
    this.name = "SchemaMismatchError";
  }
}

export class LockError extends Error {
  readonly code = 2 as const;
  constructor(message = "Could not acquire life store lock") {
    super(message);
    this.name = "LockError";
  }
}

export class LifeStore {
  readonly paths: LifePaths;
  private lockHeld = false;

  constructor(home: string, lifeDirRel = "data/life") {
    this.paths = lifePaths(home, lifeDirRel);
  }

  static async init(home: string): Promise<LifeStore> {
    const store = new LifeStore(home);
    const now = new Date().toISOString();
    const p = store.paths;

    await fs.mkdir(p.lifeDir, { recursive: true });
    await fs.mkdir(p.threadsDir, { recursive: true });
    await fs.mkdir(p.indexDir, { recursive: true });
    await fs.mkdir(p.ticksDir, { recursive: true });
    await fs.mkdir(path.resolve(home, "data/corpus"), { recursive: true });

    const meta: Meta = {
      oren_id: randomUUID(),
      schema_version: SCHEMA_VERSION,
      created_at: now,
      last_tick_at: null,
      tick_count: 0,
    };
    const config = defaultConfig();
    const taste = defaultTaste(now);
    const affect = defaultAffect(now);

    await atomicWriteJson(p.meta, meta);
    await atomicWriteJson(p.config, config);
    await atomicWriteJson(p.taste, taste);
    await atomicWriteJson(p.affect, affect);
    await atomicWriteJson(p.corpusIndex, { docs: [], updated_at: now });
    await fs.writeFile(p.stream, "", "utf8");

    const corpusReadme = path.resolve(home, "data/corpus/README.md");
    try {
      await fs.access(corpusReadme);
    } catch {
      await fs.writeFile(
        corpusReadme,
        [
          "# Oren corpus",
          "",
          "Place `.md` or `.txt` files here for Oren to read during contemplation ticks.",
          "Oren never writes to this directory.",
          "",
        ].join("\n"),
        "utf8",
      );
    }

    return store;
  }

  async acquireLock(): Promise<void> {
    try {
      const handle = await fs.open(this.paths.lock, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        "utf8",
      );
      await handle.close();
      this.lockHeld = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new LockError();
      }
      throw err;
    }
  }

  async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    try {
      await fs.unlink(this.paths.lock);
    } catch {
      // ignore
    }
    this.lockHeld = false;
  }

  async load(): Promise<LifeState> {
    const p = this.paths;
    try {
      await fs.access(p.meta);
    } catch {
      throw new NotInitializedError();
    }

    const meta = await readJson<Meta>(p.meta);
    if (meta.schema_version !== SCHEMA_VERSION) {
      throw new SchemaMismatchError(
        `schema_version ${meta.schema_version} != ${SCHEMA_VERSION}; re-init required`,
      );
    }
    const config = await readJson<Config>(p.config);
    const taste = await readJson<Taste>(p.taste);
    const affect = await readJson<Affect>(p.affect);
    const threads = await this.loadThreads();

    return { meta, config, taste, affect, threads };
  }

  async loadThreads(): Promise<Record<string, Thread>> {
    const out: Record<string, Thread> = {};
    let names: string[];
    try {
      names = await fs.readdir(this.paths.threadsDir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const thread = await readJson<Thread>(path.join(this.paths.threadsDir, name));
      out[thread.id] = thread;
    }
    return out;
  }

  async readStreamTail(limit = 50): Promise<StreamEvent[]> {
    try {
      const text = await fs.readFile(this.paths.stream, "utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      const slice = lines.slice(-limit);
      return slice.map((line) => JSON.parse(line) as StreamEvent);
    } catch {
      return [];
    }
  }

  async appendStream(events: StreamEvent[]): Promise<void> {
    if (events.length === 0) return;
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.appendFile(this.paths.stream, lines, "utf8");
  }

  async saveMeta(meta: Meta): Promise<void> {
    await atomicWriteJson(this.paths.meta, meta);
  }

  async saveConfig(config: Config): Promise<void> {
    await atomicWriteJson(this.paths.config, config);
  }

  async saveTaste(taste: Taste): Promise<void> {
    await atomicWriteJson(this.paths.taste, taste);
  }

  async saveAffect(affect: Affect): Promise<void> {
    await atomicWriteJson(this.paths.affect, affect);
  }

  async saveThread(thread: Thread): Promise<void> {
    await atomicWriteJson(path.join(this.paths.threadsDir, `${thread.id}.json`), thread);
  }

  async saveCorpusIndex(index: unknown): Promise<void> {
    await atomicWriteJson(this.paths.corpusIndex, index);
  }

  async writeTickSnapshot(tickId: string, snapshot: unknown): Promise<void> {
    await atomicWriteJson(path.join(this.paths.ticksDir, `${tickId}.json`), snapshot);
  }

  /**
   * Persist order: mutated JSON → stream events including tick_finished → meta.
   */
  async persistSuccess(args: {
    meta: Meta;
    taste: Taste;
    affect: Affect;
    threads: Record<string, Thread>;
    threadIdsTouched: string[];
    streamEvents: StreamEvent[];
    tickSnapshot: unknown;
    tickId: string;
  }): Promise<void> {
    await this.saveTaste(args.taste);
    await this.saveAffect(args.affect);
    for (const id of args.threadIdsTouched) {
      const t = args.threads[id];
      if (t) await this.saveThread(t);
    }
    await this.writeTickSnapshot(args.tickId, args.tickSnapshot);
    await this.appendStream(args.streamEvents);
    await this.saveMeta(args.meta);
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text) as T;
}
