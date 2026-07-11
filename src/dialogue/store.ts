import fs from "node:fs/promises";
import type { LifeStore } from "../store/life-store.js";
import type { DialogueTurn } from "../types.js";

export async function appendDialogue(
  store: LifeStore,
  turns: DialogueTurn[],
): Promise<void> {
  if (turns.length === 0) return;
  const lines = turns.map((t) => JSON.stringify(t)).join("\n") + "\n";
  await fs.appendFile(store.paths.dialogue, lines, "utf8");
}

export async function readDialogueTail(
  store: LifeStore,
  limit = 20,
): Promise<DialogueTurn[]> {
  try {
    const text = await fs.readFile(store.paths.dialogue, "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-limit).map((l) => JSON.parse(l) as DialogueTurn);
  } catch {
    return [];
  }
}
