import { runEvals } from "./cli.js";

const exitCode = await runEvals(process.env, (line) => console.log(line));
process.exitCode = exitCode;
