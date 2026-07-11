import fs from "node:fs/promises";
import path from "node:path";
import { corpusDir } from "../paths.js";
import type { Config } from "../types.js";

export interface CorpusFileInfo {
  path: string;
  bytes: number;
  mtime_ms: number;
  preview: string;
}

/** List relative paths of .md/.txt under corpus (excludes README.md). */
export async function listCorpusFiles(
  home: string,
  config: Config,
): Promise<CorpusFileInfo[]> {
  const root = corpusDir(home, config);
  const out: CorpusFileInfo[] = [];
  await walk(root, root, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function readCorpusFile(
  home: string,
  config: Config,
  name: string,
): Promise<{ path: string; content: string; bytes: number }> {
  const abs = resolveCorpusPath(home, config, name);
  const content = await fs.readFile(abs, "utf8");
  const st = await fs.stat(abs);
  return { path: sanitizeCorpusName(name), content, bytes: st.size };
}

/**
 * Write a safe corpus file. name must be basename-like .md/.txt, no path traversal.
 */
export async function writeCorpusFile(
  home: string,
  config: Config,
  name: string,
  content: string,
): Promise<CorpusFileInfo> {
  await ensureCorpusRoot(home, config);
  const safe = sanitizeCorpusName(name);
  const abs = resolveCorpusPath(home, config, safe);
  await fs.writeFile(abs, content, "utf8");
  const st = await fs.stat(abs);
  return {
    path: safe,
    bytes: st.size,
    mtime_ms: st.mtimeMs,
    preview: content.slice(0, 200).replace(/\s+/g, " ").trim(),
  };
}

export async function deleteCorpusFile(
  home: string,
  config: Config,
  name: string,
): Promise<{ path: string; deleted: true }> {
  const safe = sanitizeCorpusName(name);
  const abs = resolveCorpusPath(home, config, safe);
  await fs.unlink(abs);
  return { path: safe, deleted: true };
}

export function sanitizeCorpusName(name: string): string {
  const raw = name.trim();
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
    throw new Error("invalid file name");
  }
  const base = path.basename(raw);
  if (!base || base === "." || base === "..") {
    throw new Error("invalid file name");
  }
  if (!/\.(md|txt|markdown)$/i.test(base)) {
    throw new Error("only .md / .txt / .markdown allowed");
  }
  if (base.toLowerCase() === "readme.md") {
    throw new Error("cannot modify README.md via API");
  }
  return base;
}

function resolveCorpusPath(
  home: string,
  config: Config,
  name: string,
  opts?: { createRoot?: boolean },
): string {
  const safe = sanitizeCorpusName(name);
  const root = path.resolve(corpusDir(home, config));
  if (opts?.createRoot) {
    // mkdir sync via promise caller
  }
  const abs = path.resolve(path.join(root, safe));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("invalid corpus path");
  }
  return abs;
}

async function walk(root: string, dir: string, out: CorpusFileInfo[]): Promise<void> {
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(root, abs, out);
    } else if (e.isFile() && /\.(md|txt|markdown)$/i.test(e.name) && e.name !== "README.md") {
      const st = await fs.stat(abs);
      const text = await fs.readFile(abs, "utf8");
      out.push({
        path: path.relative(root, abs).split(path.sep).join("/"),
        bytes: st.size,
        mtime_ms: st.mtimeMs,
        preview: text.slice(0, 200).replace(/\s+/g, " ").trim(),
      });
    }
  }
}

/** Ensure parent dir exists before write — used by writeCorpusFile */
export async function ensureCorpusRoot(home: string, config: Config): Promise<void> {
  await fs.mkdir(corpusDir(home, config), { recursive: true });
}
