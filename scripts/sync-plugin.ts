import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keeps the Claude Code plugin in lockstep with the npm package. Plugin users only get an update when
// plugin.json's version changes, and the server they run is the package version that .mcp.json pins for npx,
// so both follow package.json. npm runs this as the "version" script, so `npm version` moves all three in one
// commit; with --check, as before publishing, it only reports drift.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "overseer");
const MANIFEST = path.join(PLUGIN, ".claude-plugin", "plugin.json");
const MCP = path.join(PLUGIN, ".mcp.json");

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file: string, value: unknown) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const { name, version } = read(path.join(ROOT, "package.json"));
const manifest = read(MANIFEST);
const mcp = read(MCP);
const args: string[] = mcp.mcpServers?.overseer?.args ?? [];
const at = args.findIndex((arg) => arg === name || arg.startsWith(`${name}@`));
if (at < 0) throw new Error(`${path.relative(ROOT, MCP)} doesn't run ${name}.`);

const spec = `${name}@${version}`;
const drift = [
  manifest.version !== version ? `plugin.json says version ${manifest.version}` : "",
  args[at] !== spec ? `.mcp.json runs ${args[at]}` : "",
].filter(Boolean);

if (!drift.length) {
  console.log(`The plugin is in step with ${spec}.`);
} else if (process.argv.includes("--check")) {
  console.error(`The plugin is out of step with package.json (${version}): ${drift.join(" and ")}. Run node scripts/sync-plugin.ts.`);
  process.exit(1);
} else {
  manifest.version = version;
  args[at] = spec;
  write(MANIFEST, manifest);
  write(MCP, mcp);
  console.log(`Moved the plugin to ${spec}.`);
}
