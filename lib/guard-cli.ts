// overseer guard: the command line for lib/guard.ts. It prints what a repository's agent configuration does,
// for a person, as JSON, or as GitHub Actions annotations, and installs the git hooks that run it after a
// checkout, merge or rebase. Node.js built-ins only, like guard itself, so bin.ts can start it without loading
// the rest of Overseer, and the Action's guard mode needs no npm install.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GuardError, PATHSPECS, RULES, kindLabel, loadState, projectFolder, ruleShort, scanRepo, warnings, type Entry, type Scan } from "./guard.ts";

export const GUARD_HELP = `Usage: overseer guard [folder] [options]
       overseer guard install --git [--global]

Lists the files in a repository that steer Claude Code: CLAUDE.md and AGENTS.md files, agents, skills,
commands, settings, MCP servers and the scripts hooks run, and the files other tools run by themselves, such as
VS Code tasks. Then it flags what this year's attacks did with them: hooks that run code, hidden characters,
reviewers pinned to a weaker model, broad pre-approvals, redirected API endpoints, secrets in plain text.
It's free and local: it reads files and asks git for the file list, runs none of the repository's code, and
sends nothing anywhere. A clean result means none of its patterns matched, not that the files are safe:
overseer check tests what instructions make a model do.

Options
  --since <ref>     only files that changed between this git ref and HEAD, such as a pull request's base
  --all             list every file with its notes, not just the flagged ones
  --json            print the report as JSON
  --github          also write GitHub Actions annotations, a job summary and outputs

install --git       add post-checkout, post-merge and post-rewrite hooks to this repository, so a checkout,
                    pull or rebase that brings in agent configuration is checked before Claude Code starts
  --global          put them in git's template folder instead, so repositories you clone or init get them

Rules
${Object.entries(RULES)
  .map(([id, text]) => `  ${id}  ${text}`)
  .join("\n")}

Exit codes: 0 nothing flagged, 1 something flagged, 2 the command line was wrong, 3 it couldn't scan.
OVERSEER_GUARD=off turns off guard's hooks in Claude Code and git.`;

const HOOK_MARKER = "overseer-guard-hook v1";
const GIT_HOOKS = ["post-checkout", "post-merge", "post-rewrite"] as const;
const NULL_SHA = "0000000000000000000000000000000000000000";

class Usage extends Error {}

const tty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const styles = (on: boolean) => {
  const paint = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { red: paint("1;38;5;203"), dim: paint("2"), bold: paint("1") };
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const tilde = (p: string) => (p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

// Runs overseer guard with these arguments and returns the exit code. version is the package's, for the hooks.
export async function guardMain(argv: string[], version: string): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(GUARD_HELP);
    return 0;
  }
  try {
    if (argv[0] === "install") return install(argv.slice(1), version);
    return run(argv);
  } catch (err) {
    if (err instanceof Usage) {
      console.error(`overseer guard: ${err.message}`);
      return 2;
    }
    if (err instanceof GuardError) {
      console.error(`overseer guard: ${err.message}`);
      return 3;
    }
    throw err;
  }
}

function options(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        since: { type: "string" },
        all: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        github: { type: "boolean", default: false },
        "git-hook": { type: "string" },
        git: { type: "boolean", default: false },
        global: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    throw new Usage(`${(err as Error).message}. Run overseer guard --help for the options.`);
  }
}

function run(argv: string[]): number {
  const { values, positionals } = options(argv);
  if (values.git || values.global) throw new Usage("--git and --global go with install: overseer guard install --git");
  if (values["git-hook"] !== undefined) return gitHook(values["git-hook"], positionals);
  if (positionals.length > 1) throw new Usage(`takes one folder, not ${positionals.length}: ${positionals.join(" ")}`);
  const given = path.resolve(positionals[0] ?? ".");
  const root = projectFolder(given);
  if (!root) throw new Usage(fs.existsSync(given) ? `scans a project's folder, and ${tilde(given)} is your home folder or the filesystem's root, which would read far beyond one project.` : `${tilde(given)} doesn't exist.`);
  const since = values.since?.trim();
  if (values.since !== undefined && !since) throw new Usage("--since takes a git ref, such as origin/main.");
  const scan = scanRepo(root, { since, previous: since ? null : loadState(root) });
  const flagged = scan.files.filter((e) => warnings(e).length);
  if (values.json) console.log(JSON.stringify({ root: scan.root, head: scan.head, since: scan.since ?? null, flagged: flagged.length, files: scan.files, removed: scan.removed }, null, 2));
  else console.log(report(scan, flagged, values.all, tty));
  if (values.github) github(scan, flagged);
  return flagged.length ? 1 : 0;
}

// The report for a person, for a folder already scanned. The MCP server's overseer_guard returns it too.
export function guardReport(root: string, since?: string, all = false): string {
  const scan = scanRepo(root, { since, previous: since ? null : loadState(root) });
  return report(scan, scan.files.filter((e) => warnings(e).length), all, false);
}

function report(scan: Scan, flagged: Entry[], all: boolean, color: boolean): string {
  const { red, dim, bold } = styles(color);
  const config = scan.files.filter((e) => e.kind !== "docs");
  const docs = scan.files.length - config.length;
  const where = scan.since ? `changed since ${scan.since}` : `in ${tilde(scan.root)}`;
  const lines = [
    `${bold("Overseer guard")}: ${plural(config.length, "agent-config file")} ${where}${docs ? `, and ${plural(docs, "doc")} checked for hidden text` : ""}. ${flagged.length ? red(`${flagged.length} flagged.`) : "Nothing flagged."}`,
  ];
  const listed = all ? scan.files : flagged;
  for (const e of listed) {
    const status = e.status === "new" ? ", new since the last session" : e.status === "changed" ? ", changed since the last session" : "";
    const mark = warnings(e).length ? red("✗") : e.findings.length ? "·" : dim("✓");
    lines.push("", `${mark} ${bold(e.path)} ${dim(`(${kindLabel(e)}${status})`)}`);
    for (const f of all ? e.findings : warnings(e)) {
      lines.push(`    ${dim(`line ${String(f.line).padEnd(4)}`)} ${f.severity === "warn" ? red(f.rule) : f.rule}  ${f.message}`);
    }
  }
  const rest = config.filter((e) => !listed.includes(e));
  if (rest.length) {
    const names = rest.slice(0, 6).map((e) => e.path).join(", ");
    lines.push("", dim(`${plural(rest.length, "more file")} with nothing flagged: ${names}${rest.length > 6 ? ` and ${rest.length - 6} more` : ""}.${all ? "" : " --all lists every file with its notes."}`));
  }
  if (scan.removed.length) lines.push(dim(`Gone since the last session: ${scan.removed.join(", ")}`));
  lines.push(
    "",
    dim(
      flagged.length
        ? "Free and local: nothing was sent anywhere. Read each flagged file before you start Claude Code here. For instructions that might carry an agenda, overseer check tests what they make a model do."
        : "Free and local: nothing was sent anywhere. Nothing matched, which isn't proof the files are safe.",
    ),
  );
  return lines.join("\n");
}

// Run by a git hook, with git's arguments for it: what came in since the previous commit, and only what's
// flagged, on the terminal git is writing to. It never fails the git command, whatever happens.
function gitHook(name: string, args: string[]): number {
  let base: string | null;
  if (name === "post-checkout") {
    // A file checkout (flag 0) changes no commit, and a fresh clone has no previous commit to compare with.
    if (args[2] !== "1") return 0;
    base = args[0] === NULL_SHA ? null : (args[0] ?? null);
    if (base !== null && base === args[1]) return 0;
  } else if (name === "post-merge") {
    base = "ORIG_HEAD";
  } else if (name === "post-rewrite") {
    if (args[0] !== "rebase") return 0;
    base = "ORIG_HEAD";
  } else {
    throw new Usage(`--git-hook takes post-checkout, post-merge or post-rewrite, not "${name}".`);
  }
  try {
    const root = projectFolder(process.cwd());
    if (!root) return 0;
    const scan = scanRepo(root, { since: base ?? undefined, previous: null });
    const flagged = scan.files.filter((e) => warnings(e).length);
    if (flagged.length) console.error(hookReport(scan, flagged));
  } catch (err) {
    console.error(`overseer guard: couldn't check this ${name.slice(5)}: ${(err as Error).message}`);
  }
  return 0;
}

function hookReport(scan: Scan, flagged: Entry[]): string {
  const lines = flagged.slice(0, 8).map((e) => {
    const first = warnings(e)[0];
    const more = warnings(e).length > 1 ? ` (+${warnings(e).length - 1} more)` : "";
    return `  ${e.path} ${first.message}${more}`;
  });
  return [
    `Overseer guard: this ${scan.since ? "change" : "checkout"} brings in agent configuration that needs a look before you start Claude Code here:`,
    ...lines,
    flagged.length > 8 ? `  and ${flagged.length - 8} more` : "",
    `Free and local, nothing was sent. Details: npx @adamsaou/overseer guard${scan.since ? ` --since ${scan.since}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// GitHub's workflow commands, escaped as its toolkit does.
const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function github(scan: Scan, flagged: Entry[]) {
  // Annotations name files from the repository's root, which may be above the folder scanned.
  let top = scan.root;
  try {
    top = execFileSync("git", ["-C", scan.root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || scan.root;
  } catch {
    // Not in git: paths stay relative to the folder.
  }
  const fromTop = (rel: string) => path.relative(top, path.join(scan.root, rel)).split(path.sep).join("/");
  for (const e of flagged) {
    for (const f of warnings(e)) console.log(`::warning file=${escapeProperty(fromTop(e.path))},line=${f.line},title=${escapeProperty(`Overseer guard ${ruleShort(f.rule)}`)}::${escapeData(`${e.path} ${f.message}`)}`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = flagged.flatMap((e) => warnings(e).map((f) => `| \`${fromTop(e.path)}\` | ${f.line} | ${ruleShort(f.rule)} | ${f.message.replace(/\|/g, "\\|")} |`));
    const text = flagged.length
      ? `### Overseer guard: ${plural(flagged.length, "file")} flagged\n\n| File | Line | Rule | What it does |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\nFree and local: guard reads files and runs none of them.\n`
      : `### Overseer guard: nothing flagged\n\n${plural(scan.files.length, "file")} ${scan.since ? `changed since ${scan.since}` : "checked"}. Nothing matched, which isn't proof the files are safe.\n`;
    fs.appendFileSync(summary, text);
  }
  const output = process.env.GITHUB_OUTPUT;
  if (output) fs.appendFileSync(output, `result=${flagged.length ? "fail" : "pass"}\nflagged=${flagged.length}\n`);
}

// ---- Git hooks

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// The hook git runs. The cheap check comes first, so a checkout that changes no agent configuration costs a
// git diff, and Overseer only starts when something it reads came in.
export function hookScript(name: (typeof GIT_HOOKS)[number], version: string): string {
  const pick = {
    // A rebase checks out commits as it goes; post-rewrite reports once at the end.
    "post-checkout": `[ "$3" = 1 ] || exit 0\n[ -d "$(git rev-parse --git-path rebase-merge)" ] && exit 0\n[ -d "$(git rev-parse --git-path rebase-apply)" ] && exit 0\nbase=$1`,
    "post-merge": "base=ORIG_HEAD",
    "post-rewrite": `[ "$1" = rebase ] || exit 0\nbase=ORIG_HEAD`,
  }[name];
  return `#!/bin/sh
# Overseer guard (${HOOK_MARKER}), installed by overseer guard install --git. After a checkout, merge or
# rebase, it checks the agent configuration that came in (CLAUDE.md files, .claude/, .mcp.json and the like)
# before Claude Code starts here. Free and local. It never fails the git command: OVERSEER_GUARD=off skips
# it, and deleting this file removes it.
[ "$OVERSEER_GUARD" = off ] && exit 0
${pick}
# Only a change to agent configuration starts Overseer. A fresh clone's base is all zeros, so it's compared
# with an empty tree, and a repository without agent configuration stays quiet.
case $base in *[!0]*) ;; *) base=$(git hash-object -t tree /dev/null) ;; esac
git diff --quiet "$base" HEAD -- ${PATHSPECS.map(quote).join(" ")} 2>/dev/null && exit 0
if [ -n "$OVERSEER_GUARD_BIN" ]; then
  $OVERSEER_GUARD_BIN guard --git-hook ${name} "$@" </dev/null || true
elif command -v npx >/dev/null 2>&1; then
  ${chainLine(name, version)} </dev/null || true
fi
exit 0
`;
}

// The line that runs guard from a hook of someone else's, with that hook's own arguments. npm's log level is
// warn, or npx would print its "npm notice run" lines on every run.
const chainLine = (name: string, version: string) => `npm_config_loglevel=warn npx -y @adamsaou/overseer@${version} guard --git-hook ${name} "$@"`;

function git(args: string[], cwd = process.cwd()): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function install(argv: string[], version: string): number {
  const { values, positionals } = options(argv);
  if (!values.git) throw new Usage("install takes --git: overseer guard install --git [--global]");
  if (positionals.length) throw new Usage(`install takes no folder; run it in the repository: ${positionals.join(" ")}`);
  let dir: string;
  if (values.global) {
    const configured = git(["config", "--global", "--get", "init.templateDir"]);
    const template = configured ? path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), ".git-templates");
    if (!configured) {
      execFileSync("git", ["config", "--global", "init.templateDir", template]);
      console.log(`Set git's init.templateDir to ${tilde(template)}, which wasn't set before.`);
    }
    dir = path.join(template, "hooks");
  } else {
    if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Usage("install --git runs inside a git repository; --global installs for every repository you clone.");
    const custom = git(["config", "--get", "core.hooksPath"]);
    if (custom) {
      console.error(
        `This repository keeps its hooks in ${custom} (core.hooksPath, as husky does), which may be committed, so guard won't write there. To chain guard, add the line for each hook to it:\n${GIT_HOOKS.map((n) => `  ${n}: ${chainLine(n, version)} || true`).join("\n")}`,
      );
      return 3;
    }
    dir = path.resolve(git(["rev-parse", "--git-path", "hooks"]) ?? ".git/hooks");
  }
  fs.mkdirSync(dir, { recursive: true });
  const skipped: string[] = [];
  for (const name of GIT_HOOKS) {
    const file = path.join(dir, name);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (existing !== null && !existing.includes(HOOK_MARKER)) {
      skipped.push(name);
      continue;
    }
    fs.writeFileSync(file, hookScript(name, version), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  const installed = GIT_HOOKS.filter((n) => !skipped.includes(n));
  if (installed.length) console.log(`Installed ${installed.join(", ")} in ${tilde(dir)}. They run Overseer ${version} through npx when a checkout, pull or rebase brings in agent configuration.`);
  if (skipped.length) {
    console.log(`Left ${skipped.join(" and ")} alone: ${skipped.length === 1 ? "it isn't" : "they aren't"} guard's. To chain guard, add its line:\n${skipped.map((n) => `  ${n}: ${chainLine(n, version)} || true`).join("\n")}`);
  }
  if (values.global) console.log("New clones get the hooks. For a repository you already have, run git init in it, which adds hooks it lacks, or overseer guard install --git there.");
  return skipped.length && !installed.length ? 3 : 0;
}
