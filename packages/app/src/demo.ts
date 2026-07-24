import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeRuntime } from "./life-runtime.js";

const directory = mkdtempSync(join(tmpdir(), "oren-demo-"));
const databasePath = join(directory, "life.db");

const first = await LifeRuntime.createDeterministic(databasePath);
await first.initialize("oren-demo", "person-demo");
await first.receiveUserMessage(
  "oren-demo",
  "person-demo",
  "Inspect and increment the counter",
);
await first.drain();
const beforeRestart = first.inspect("oren-demo");
await first.close();

const second = await LifeRuntime.createDeterministic(databasePath);
await second.drain();
const afterRestart = second.inspect("oren-demo");
await second.close();

if (JSON.stringify(afterRestart) !== JSON.stringify(beforeRestart)) {
  throw new Error("Durable replay did not reproduce the pre-restart LifeState");
}
if (
  afterRestart.pendingEffectIds.length !== 0
  || afterRestart.attention.currentFocus !== "Understand the counter lifecycle"
) {
  throw new Error("Durable counter lifecycle did not settle");
}

console.log("Oren demo completed; restart replay matched");
