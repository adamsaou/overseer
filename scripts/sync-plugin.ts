import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keeps the Claude Code plugin in lockstep with the npm package. Plugin users only get an update when
// plugin.json's version changes, and the server they run is the package version that .mcp.json pins for npx,
// so both follow package.json, and so do the versions the CI recipes and the drift monitor pin. npm runs this
// as the "version" script, so `npm version` moves them all in one commit; with --check, as before publishing,
// it only reports drift, and that every tool the plugin's skills use is one the server registers.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "overseer");
const MANIFEST = path.join(PLUGIN, ".claude-plugin", "plugin.json");
const MCP = path.join(PLUGIN, ".mcp.json");
// Files that run a pinned version of the package, by @adamsaou/overseer@<version> or OVERSEER_VERSION.
const PINNED = ["examples/ci/gitlab-ci.yml", "examples/ci/pre-push", "docs/ci.md", "examples/training/monitor.py", "examples/training/README.md"];

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file: string, value: unknown) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const { name, version } = read(path.join(ROOT, "package.json"));
const manifest = read(MANIFEST);
const mcp = read(MCP);
const args: string[] = mcp.mcpServers?.overseer?.args ?? [];
const at = args.findIndex((arg) => arg === name || arg.startsWith(`${name}@`));
if (at < 0) throw new Error(`${path.relative(ROOT, MCP)} doesn't run ${name}.`);

const spec = `${name}@${version}`;
const semver = String.raw`\d+\.\d+\.\d+(?:-[\w.]+)?`;
const pins = [new RegExp(`(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@)${semver}`, "g"), new RegExp(`(OVERSEER_VERSION: ")${semver}(?=")`, "g")];
const repinned = (text: string) => pins.reduce((out, pin) => out.replace(pin, `$1${version}`), text);
const stale = PINNED.filter((file) => {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return repinned(text) !== text;
});
const drift = [
  manifest.version !== version ? `plugin.json says version ${manifest.version}` : "",
  args[at] !== spec ? `.mcp.json runs ${args[at]}` : "",
  stale.length ? `${stale.join(", ")} ${stale.length === 1 ? "pins" : "pin"} another version` : "",
].filter(Boolean);

if (process.argv.includes("--check")) {
  // A skill that names a tool the server doesn't register would fail for everyone who installs this version.
  const registered = new Set([...fs.readFileSync(path.join(ROOT, "mcp.ts"), "utf8").matchAll(/registerTool\(\s*"([\w-]+)"/g)].map((m) => m[1]));
  const skills = path.join(PLUGIN, "skills");
  const missing = fs.readdirSync(skills).flatMap((skill) => {
    const text = fs.readFileSync(path.join(skills, skill, "SKILL.md"), "utf8");
    return [...text.matchAll(/mcp__plugin_overseer_overseer__([\w-]+)/g)].filter((m) => !registered.has(m[1])).map((m) => `${m[1]} (skills/${skill})`);
  });
  if (missing.length) {
    console.error(`The plugin's skills use tools that mcp.ts doesn't register: ${[...new Set(missing)].join(", ")}.`);
    process.exit(1);
  }
}

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
  for (const file of stale) fs.writeFileSync(path.join(ROOT, file), repinned(fs.readFileSync(path.join(ROOT, file), "utf8")));
  console.log(`Moved the plugin to ${spec}${stale.length ? `, and the pins in ${stale.join(", ")}` : ""}.`);
}
