import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export interface CorpusChunk {
  chunk_id: string;
  start_line: number;
  end_line: number;
  preview: string;
  text: string;
}

export interface CorpusDoc {
  path: string;
  hash: string;
  mtime_ms: number;
  preview: string;
  chunks: CorpusChunk[];
}

export interface CorpusIndex {
  docs: CorpusDoc[];
  updated_at: string;
}

const TEXT_EXT = new Set([".md", ".txt", ".markdown"]);

export async function buildCorpusIndex(corpusDir: string): Promise<CorpusIndex> {
  const docs: CorpusDoc[] = [];
  let entries: string[];
  try {
    entries = await walkFiles(corpusDir);
  } catch {
    return { docs: [], updated_at: new Date().toISOString() };
  }

  for (const abs of entries) {
    const rel = path.relative(corpusDir, abs).split(path.sep).join("/");
    if (rel === "README.md") continue;
    const ext = path.extname(rel).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;

    const stat = await fs.stat(abs);
    const text = await fs.readFile(abs, "utf8");
    const hash = createHash("sha256").update(text).digest("hex");
    const chunks = chunkText(text, rel);
    docs.push({
      path: rel,
      hash,
      mtime_ms: stat.mtimeMs,
      preview: text.slice(0, 240).replace(/\s+/g, " ").trim(),
      chunks,
    });
  }

  docs.sort((a, b) => a.path.localeCompare(b.path));
  return { docs, updated_at: new Date().toISOString() };
}

export function chunkText(text: string, docPath: string): CorpusChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: CorpusChunk[] = [];
  let start = 0;
  let buf: string[] = [];

  const flush = (endLine: number) => {
    if (buf.length === 0) return;
    const body = buf.join("\n").trim();
    if (!body) {
      buf = [];
      start = endLine + 1;
      return;
    }
    const idx = chunks.length;
    chunks.push({
      chunk_id: `${docPath}#${idx}`,
      start_line: start + 1,
      end_line: endLine + 1,
      preview: body.slice(0, 200).replace(/\s+/g, " ").trim(),
      text: body,
    });
    buf = [];
    start = endLine + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" && buf.length > 0) {
      flush(i - 1);
      continue;
    }
    if (line.trim() !== "") {
      if (buf.length === 0) start = i;
      buf.push(line);
    }
  }
  flush(lines.length - 1);

  if (chunks.length === 0 && text.trim()) {
    chunks.push({
      chunk_id: `${docPath}#0`,
      start_line: 1,
      end_line: Math.max(1, lines.length),
      preview: text.slice(0, 200).replace(/\s+/g, " ").trim(),
      text: text.trim(),
    });
  }

  return chunks;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const ents = await fs.readdir(cur, { withFileTypes: true });
    for (const ent of ents) {
      const abs = path.join(cur, ent.name);
      if (ent.name.startsWith(".")) continue;
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile()) out.push(abs);
    }
  }
  return out;
}
