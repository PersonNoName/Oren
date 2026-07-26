import { PiCognitionAdapter, resolveModelConfig } from "@oren/pi-cognition";
import { redactSecrets } from "./redact.js";
import { startServe } from "./serve-runner.js";

const env = process.env;
const configSearchFrom = env.OREN_CONFIG_SEARCH_FROM?.trim();
const model = resolveModelConfig(
  env,
  configSearchFrom ? { searchFrom: configSearchFrom } : undefined,
);
if (!model.ok) {
  console.error(redactSecrets(model.reason));
  process.exit(1);
}

const handle = await startServe({
  cognition: new PiCognitionAdapter({
    model: model.model,
    streamFn: model.streamFn,
  }),
  env,
  log: (line) => console.log(line),
});
console.log(redactSecrets(`Oren model=${model.model.provider}/${model.model.id}`));

const shutdown = async () => {
  try {
    await handle.stop();
  } finally {
    process.exit(0);
  }
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
