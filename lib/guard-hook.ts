// The plugin's guard hooks, bundled into plugins/overseer/scripts/guard.mjs by scripts/build-hooks.ts.
// SessionStart scans the project's agent configuration, and your own setup (~/.claude and your plugins, which
// apply in every project), against what guard saw last time; it tells the user in one line and Claude in a few
// what needs a look, and has Claude Code watch those files. FileChanged rescans when one changes, whatever
// changed it: Claude, a script it ran, git or another process. Free and local, it never blocks, and
// OVERSEER_GUARD=off (or OVERSEER_HOOK=off, for all of Overseer's hooks) turns it off.

import fs from "node:fs";
import path from "node:path";
import {
  OFF,
  describe,
  loadState,
  pluginsIn,
  projectFolder,
  repositoryTurnsGuardOff,
  saveState,
  scanRepo,
  scanUser,
  sessionNotes,
  toPointOut,
  userRoot,
  warnings,
  watchPaths,
  type Entry,
  type RepoState,
  type Scan,
} from "./guard.ts";

const off = (value?: string) => OFF.test(value?.trim() ?? "");

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_ROOT ?? "", ".claude-plugin", "plugin.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

type Input = { cwd?: string; file_path?: string; source?: string };
type Pass = { scan: Scan; points: Entry[]; previous: RepoState | null };

const flagged = (entries: Entry[]) => new Set(entries.filter((e) => warnings(e).length).map((e) => e.path));

// The project's agent configuration, unless Claude Code runs in the home folder or the filesystem's root.
function project(input: Input, by: string): Pass | null {
  const root = projectFolder(process.env.CLAUDE_PROJECT_DIR || input.cwd || "");
  if (!root) return null;
  const previous = loadState(root);
  const scan = scanRepo(root, { previous });
  const points = toPointOut(scan, previous);
  saveState(scan, previous, flagged(points), by, version());
  return { scan, points, previous };
}

// Your own setup. The first scan records it without pointing anything out, as it's what you chose to install;
// after that, what changes between sessions is, such as a plugin update that adds a hook.
function own(by: string): Pass {
  const previous = loadState(userRoot());
  const scan = scanUser({ previous });
  const points = previous ? toPointOut(scan, previous) : [];
  saveState(scan, previous, flagged(previous ? points : scan.files), by, version());
  return { scan, points, previous };
}

const PASSES = [
  ["this project's agent configuration", (input: Input, by: string) => project(input, by)],
  ["your own Claude Code setup", (_input: Input, by: string) => own(by)],
] as const;

function sessionStart(input: Input) {
  const messages: string[] = [];
  const context: string[] = [];
  const watch = new Set<string>();
  for (const [what, pass] of PASSES) {
    try {
      const result = pass(input, "session-start");
      if (!result) continue;
      const notes = sessionNotes(result.scan, result.points, result.previous);
      if (notes.user) messages.push(notes.user);
      if (notes.claude) context.push(notes.claude);
      if (result.scan.user && !result.previous) {
        const plugins = pluginsIn(result.scan);
        messages.push(`Overseer guard now also watches your own Claude Code setup: ~/.claude and ${plugins} plugin${plugins === 1 ? "" : "s"}. From the next session it points out what changes in them; npx @adamsaou/overseer guard --user lists what they run.`);
      }
      for (const file of watchPaths(result.scan)) watch.add(file);
    } catch (err) {
      // A scan that fails is said, so a broken guard isn't mistaken for a clean one.
      messages.push(`Overseer guard couldn't check ${what}: ${(err as Error).message}`);
    }
  }
  return {
    ...(messages.length ? { systemMessage: messages.join("\n") } : {}),
    hookSpecificOutput: { hookEventName: "SessionStart", ...(context.length ? { additionalContext: context.join("\n\n") } : {}), watchPaths: [...watch].slice(0, 500) },
  };
}

// A watched file changed during the session. Both scans run again, which the cache keeps quick, so a settings
// change that adds a hook script finds the script too. The note is for the user only: Claude Code doesn't pass a
// FileChanged hook's context to Claude.
function fileChanged(input: Input) {
  if (typeof input.file_path !== "string") return null;
  const lines: string[] = [];
  const watch = new Set<string>();
  for (const [, pass] of PASSES) {
    try {
      const result = pass(input, "file-changed");
      if (!result) continue;
      for (const e of result.points) lines.push(describe(e, result.previous?.files[e.path]?.findings).replace(/ \((new|changed) since the last session\)/, " (changed during this session)"));
      for (const file of watchPaths(result.scan)) watch.add(file);
    } catch {
      // Said at the next session start, if it keeps failing.
    }
  }
  return {
    ...(lines.length ? { systemMessage: `Overseer guard: ${lines.slice(0, 2).join("; ")}${lines.length > 2 ? `; and ${lines.length - 2} more` : ""}. /overseer:guard for details.` } : {}),
    watchPaths: [...watch].slice(0, 500),
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
  const out = event === "session-start" ? sessionStart(input) : event === "file-changed" ? fileChanged(input) : null;
  if (out) fs.writeSync(1, JSON.stringify(out));
}

try {
  main();
} catch {
  // Whatever goes wrong, the hook stays out of the way: it never blocks a session.
}
