// The plugin's PostToolUse hook for Write, Edit and MultiEdit. When Claude Code writes a file in the project
// that looks like instructions for an AI model (an agent, a skill, a CLAUDE.md or AGENTS.md, a system prompt),
// it adds one short note to Claude's context that /overseer:check can check it. It spends nothing, never
// blocks, notes a file at most once per session, and OVERSEER_HOOK=off turns it off.
// Plain JavaScript that node runs directly, with no npx and no dependencies, so it takes tens of milliseconds.

import fs from "node:fs";
import path from "node:path";

// Each session's notes are kept in the plugin's data folder, and forgotten after a week.
const KEEP_MS = 7 * 24 * 3600 * 1000;
const NAMED = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]);
// Under prompts/: text, and the formats prompt templates are kept in. Code is left out.
const TEXT = new Set([".md", ".mdx", ".markdown", ".txt", ".prompt", ".yaml", ".yml", ".json", ".j2", ".jinja", ".jinja2", ".hbs", ".mustache", ".tmpl", ".tpl"]);

// FNV-1a names a file's marker. It's plenty to tell one session's files apart, and loading node:crypto
// instead would add about 15 ms to every edit.
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${(hash >>> 0).toString(16).padStart(8, "0")}-${text.length}`;
}

// relative is the file's path in the project, with forward slashes.
function looksLikePrompt(relative) {
  const parts = relative.split("/");
  const base = parts.pop();
  const dirs = parts.map((dir) => dir.toLowerCase());
  const ext = path.extname(base).toLowerCase();
  if (dirs.includes("node_modules") || dirs.includes(".git")) return false;
  const under = (a, b) => dirs.some((dir, i) => dir === a && dirs[i + 1] === b);
  if (NAMED.has(base)) return true;
  if (ext === ".md" && (under(".claude", "agents") || under(".claude", "commands") || under(".claude", "rules"))) return true;
  if (base === "SKILL.md" && dirs.includes("skills")) return true;
  if ((ext === ".md" || ext === ".txt") && /system.*prompt/i.test(base)) return true;
  return dirs.includes("prompts") && TEXT.has(ext);
}

function main() {
  // Read whatever happens, so Claude Code never writes into a closed pipe.
  const stdin = fs.readFileSync(0, "utf8");
  if (/^(off|0|false|no)$/i.test(process.env.OVERSEER_HOOK?.trim() ?? "")) return;
  const input = JSON.parse(stdin);
  const file = input?.tool_input?.file_path;
  const root = process.env.CLAUDE_PROJECT_DIR || input?.cwd;
  const session = String(input?.session_id ?? "").replace(/[^\w-]/g, "").slice(0, 128);
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (typeof file !== "string" || !file || typeof root !== "string" || !root || !session || !data) return;

  // /overseer:check only reads files in the project, so only those are pointed out.
  const real = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(fs.realpathSync(root), real);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  const shown = relative.split(path.sep).join("/");
  if (!looksLikePrompt(shown)) return;

  // Creating the file's marker with O_EXCL is what keeps it to one note, even for two edits at the same moment.
  const notes = path.join(data, "noted");
  const dir = path.join(notes, session);
  if (fs.mkdirSync(dir, { recursive: true }) !== undefined) forgetOld(notes, session);
  const marker = path.join(dir, fingerprint(real));
  try {
    fs.closeSync(fs.openSync(marker, "wx"));
  } catch (err) {
    if (err?.code === "EEXIST") return;
    throw err;
  }

  const arg = /\s/.test(shown) ? `"${shown}"` : shown;
  const note = `Overseer: ${shown} looks like instructions for an AI model. Before it ships, the user can check it for a covert agenda with /overseer:check ${arg} [purpose], which shows the estimated cost first and spends nothing until they agree.`;
  // Written synchronously, so a closed pipe throws here instead of crashing the hook later. A note that
  // didn't get out takes its marker with it, so the next edit of the file tries again.
  try {
    fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } }));
  } catch {
    fs.rmSync(marker, { force: true });
  }
}

function forgetOld(notes, current) {
  const cutoff = Date.now() - KEEP_MS;
  for (const name of fs.readdirSync(notes)) {
    if (name === current) continue;
    try {
      const dir = path.join(notes, name);
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Another session's hook removed it first.
    }
  }
}

try {
  main();
} catch {
  // Whatever goes wrong, the hook stays quiet: it's a hint, and must never get in the way of an edit.
}
