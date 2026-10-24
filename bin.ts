#!/usr/bin/env node
// The installed overseer command. It has no static imports, so on a Node.js too old for the rest of the
// code it can still say what's wrong: npm only warns about engines, and the first module that loads
// would otherwise crash on import.meta.filename.

const MIN_NODE = 22;
const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_NODE) {
  console.error(
    `overseer: Overseer needs Node.js ${MIN_NODE} or newer, and this is ${process.version}. Upgrade from https://nodejs.org/en/download (or nvm install --lts), then run it again.`,
  );
  process.exit(1);
}
// overseer guard needs none of the rest, so git hooks and the Action's guard mode start it without loading
// the API client: it's free, local and quick.
if (process.argv[2] === "guard") {
  const [{ guardMain }, { packageVersion }] = await Promise.all([import("./lib/guard-cli.ts"), import("./lib/paths.ts")]);
  process.exitCode = await guardMain(process.argv.slice(3), packageVersion());
} else {
  await import("./cli.ts");
}
