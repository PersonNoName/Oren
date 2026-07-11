import fs from "node:fs/promises";
import path from "node:path";
import { corpusDir } from "../paths.js";
import type { Config } from "../types.js";

export interface CorpusFileInfo {
  path: string;
  bytes: number;
  mtime_ms: number;
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

/**
 * Write a safe corpus file. name must be basename-like .md/.txt, no path traversal.
 */
export async function writeCorpusFile(
  home: string,
  config: Config,
  name: string,
  content: string,
): Promise<CorpusFileInfo> {
  const safe = sanitizeCorpusName(name);
  const root = corpusDir(home, config);
  await fs.mkdir(root, { recursive: true });
  const abs = path.join(root, safe);
  // ensure still under root
  if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) {
    throw new Error("invalid corpus path");
  }
  await fs.writeFile(abs, content, "utf8");
  const st = await fs.stat(abs);
  return { path: safe, bytes: st.size, mtime_ms: st.mtimeMs };
}

export function sanitizeCorpusName(name: string): string {
  const raw = name.trim();
  if (!raw || raw.includes("/") || raw.includes("\\\\") || raw.includes("..")) {
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
    throw new Error("cannot overwrite README.md via API");
  }
  return base;
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
      out.push({
        path: path.relative(root, abs).split(path.sep).join("/"),
        bytes: st.size,
        mtime_ms: st.mtimeMs,
      });
    }
  }
}
