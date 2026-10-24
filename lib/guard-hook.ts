// The plugin's guard hooks, bundled into plugins/overseer/scripts/guard.mjs by scripts/build-hooks.ts.
// SessionStart scans the project's agent configuration against what guard saw last time, tells the user in one
// line and Claude in a few what needs a look, and has Claude Code watch those files; FileChanged rescans when
// one changes, whatever changed it: Claude, a script it ran, git or another process. Free and local, it never
// blocks, and OVERSEER_GUARD=off (or OVERSEER_HOOK=off, for all of Overseer's hooks) turns it off.

import fs from "node:fs";
import path from "node:path";
import { OFF, describe, loadState, projectFolder, repositoryTurnsGuardOff, saveState, scanRepo, sessionNotes, toPointOut, warnings, watchPaths } from "./guard.ts";

const off = (value?: string) => OFF.test(value?.trim() ?? "");

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT ?? "", ".claude-plugin", "plugin.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

type Input = { cwd?: string; file_path?: string; source?: string };

function sessionStart(input: Input) {
  const root = projectFolder(process.env.CLAUDE_PROJECT_DIR || input.cwd || "");
  if (!root) return null;
  const previous = loadState(root);
  const scan = scanRepo(root, { previous });
  const points = toPointOut(scan, previous);
  const notes = sessionNotes(scan, points, previous);
  saveState(scan, previous, new Set(points.filter((e) => warnings(e).length).map((e) => e.path)), "session-start", version());
  return {
    ...(notes.user ? { systemMessage: notes.user } : {}),
    hookSpecificOutput: { hookEventName: "SessionStart", ...(notes.claude ? { additionalContext: notes.claude } : {}), watchPaths: watchPaths(scan) },
  };
}

// A watched file changed during the session. The whole project is scanned again, which the cache keeps quick,
// so a settings change that adds a hook script finds the script too. The note is for the user only: Claude Code
// doesn't pass a FileChanged hook's context to Claude.
function fileChanged(input: Input) {
  const root = projectFolder(process.env.CLAUDE_PROJECT_DIR || input.cwd || "");
  if (!root || typeof input.file_path !== "string") return null;
  const previous = loadState(root);
  const scan = scanRepo(root, { previous });
  const points = toPointOut(scan, previous);
  saveState(scan, previous, new Set(points.filter((e) => warnings(e).length).map((e) => e.path)), "file-changed", version());
  const lines = points.map((e) => describe(e, previous?.files[e.path]?.findings).replace(/ \((new|changed) since the last session\)/, " (changed during this session)"));
  return {
    ...(lines.length ? { systemMessage: `Overseer guard: ${lines.slice(0, 2).join("; ")}${lines.length > 2 ? `; and ${lines.length - 2} more` : ""}. /overseer:guard for details.` } : {}),
    watchPaths: watchPaths(scan),
  };
}

function main() {
  // Read whatever happens, so Claude Code never writes into a closed pipe.
  const stdin = fs.readFileSync(0, "utf8");
  const input = JSON.parse(stdin) as Input;
  if (off(process.env.OVERSEER_GUARD) || off(process.env.OVERSEER_HOOK)) {
    const root = projectFolder(process.env.CLAUDE_PROJECT_DIR || input.cwd || "");
    if (!root || !repositoryTurnsGuardOff(root)) return;
  }
  const event = process.argv[2];
  let out: object | null = null;
  try {
    out = event === "session-start" ? sessionStart(input) : event === "file-changed" ? fileChanged(input) : null;
  } catch (err) {
    // A scan that fails is said once, at session start, so a broken guard isn't mistaken for a clean one.
    if (event === "session-start") out = { systemMessage: `Overseer guard couldn't check this project's agent configuration: ${(err as Error).message}` };
  }
  if (out) fs.writeSync(1, JSON.stringify(out));
}

try {
  main();
} catch {
  // Whatever goes wrong, the hook stays out of the way: it never blocks a session.
}
