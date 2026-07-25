import { runSmoke } from "./smoke-runner.js";

const exitCode = await runSmoke(process.env, (line) => console.log(line));
process.exitCode = exitCode;
