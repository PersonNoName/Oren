import path from "node:path";
import type { Config } from "./types.js";

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OREN_HOME?.trim();
  if (home && home.length > 0) {
    return path.resolve(home);
  }
  return path.resolve(process.cwd());
}

export interface LifePaths {
  home: string;
  lifeDir: string;
  meta: string;
  config: string;
  taste: string;
  affect: string;
  threadsDir: string;
  indexDir: string;
  corpusIndex: string;
  stream: string;
  ticksDir: string;
  dialogue: string;
  relation: string;
  lock: string;
}

export function lifePaths(home: string, lifeDirRel = "data/life"): LifePaths {
  const lifeDir = path.resolve(home, lifeDirRel);
  return {
    home,
    lifeDir,
    meta: path.join(lifeDir, "meta.json"),
    config: path.join(lifeDir, "config.json"),
    taste: path.join(lifeDir, "taste.json"),
    affect: path.join(lifeDir, "affect.json"),
    threadsDir: path.join(lifeDir, "threads"),
    indexDir: path.join(lifeDir, "index"),
    corpusIndex: path.join(lifeDir, "index", "corpus-index.json"),
    stream: path.join(lifeDir, "stream.jsonl"),
    ticksDir: path.join(lifeDir, "ticks"),
    dialogue: path.join(lifeDir, "dialogue.jsonl"),
    relation: path.join(lifeDir, "relation.json"),
    lock: path.join(lifeDir, ".lock"),
  };
}

export function corpusDir(home: string, config: Config): string {
  return path.resolve(home, config.corpus_dir);
}
