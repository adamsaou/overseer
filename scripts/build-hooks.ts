// Builds plugins/overseer/scripts/guard.mjs, the plugin's guard hook, from lib/guard-hook.ts and lib/guard.ts:
// one readable file with no dependencies, which node runs straight from the plugin, as it does prompt-hook.mjs.
// The plugin installs from this repository, not from npm, so the built file is committed; with --check, this
// fails when it doesn't match the source, as CI runs it.
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { BUNDLE_BANNER } from "../lib/guard.ts";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "plugins", "overseer", "scripts", "guard.mjs");

const result = await build({
  absWorkingDir: root,
  entryPoints: ["lib/guard-hook.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node22",
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  banner: { js: `${BUNDLE_BANNER}; edit those, then npm run build:hooks.` },
});
const text = result.outputFiles[0].text;

if (process.argv.includes("--check")) {
  const committed = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (committed !== text) {
    console.error(`${path.relative(root, out)} doesn't match lib/guard-hook.ts and lib/guard.ts. Run npm run build:hooks and commit it.`);
    process.exit(1);
  }
  console.log(`${path.relative(root, out)} is up to date.`);
} else {
  fs.writeFileSync(out, text);
  console.log(`${path.relative(root, out)}: ${(text.length / 1024).toFixed(0)} KB.`);
}
