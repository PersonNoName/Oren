import {
  cp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const packageRoot = join(dist, "node_modules", "@oren");
const packages = [
  ["app", "packages/app"],
  ["cognition", "packages/cognition"],
  ["extensions", "packages/extensions"],
  ["kernel", "packages/kernel"],
  ["memory", "packages/memory"],
  ["web", "packages/web"],
  ["channel", "packages/channel"],
  ["panel", "packages/panel"],
  ["pi-cognition", "packages/pi-cognition"],
  ["evals", "packages/evals"],
  ["sim", "packages/sim"],
  ["storage", "packages/storage"],
  ["test-counter", "extensions/test-counter"],
];

await rm(join(dist, "node_modules"), { recursive: true, force: true });
for (const [name, output] of packages) {
  const directory = join(packageRoot, name);
  const compiledSource = join(dist, output, "src");
  await mkdir(directory, { recursive: true });
  await symlink(relative(directory, compiledSource), join(directory, "src"), "dir");
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({
      name: `@oren/${name}`,
      private: true,
      type: "module",
      exports: "./src/index.js",
    }, null, 2)}\n`,
  );
}

// Panel serves HTML from a sibling `static/` directory next to compiled server.js.
const panelStaticSrc = join(root, "packages/panel/src/static");
const panelStaticDist = join(dist, "packages/panel/src/static");
await cp(panelStaticSrc, panelStaticDist, { recursive: true });
