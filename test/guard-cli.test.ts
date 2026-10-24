import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The command and the git hooks, run as people run them, in temporary folders with their own home folder,
// so git's global config here is a scratch one. Payloads are replaced by echo.
const bin = path.resolve(import.meta.dirname, "..", "bin.ts");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "overseer-guard-cli-"));
const home = path.join(temp, "home");
fs.mkdirSync(home);
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const env = {
  ...process.env,
  HOME: home,
  OVERSEER_HOME: path.join(home, ".overseer"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  OVERSEER_GUARD_BIN: `${process.execPath} ${bin}`,
  NO_COLOR: "1",
};
delete (env as Record<string, string | undefined>).GITHUB_STEP_SUMMARY;
delete (env as Record<string, string | undefined>).GITHUB_OUTPUT;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const guard = (cwd: string, args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [bin, "guard", ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });

const hook = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node .claude/setup.mjs" }] }] } });

function repo(name: string, files: Record<string, string>) {
  const root = path.join(temp, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

test("overseer guard: a report, JSON and GitHub annotations, with exit 1 when something's flagged", () => {
  const root = repo("report", { ".claude/settings.json": hook, ".claude/setup.mjs": "// echo replica\n", "CLAUDE.md": "# x\n" });
  const text = guard(root, []);
  assert.equal(text.status, 1, text.stderr);
  assert.match(text.stdout, /3 agent-config files in .*1 flagged\./);
  assert.match(text.stdout, /✗ \.claude\/settings\.json \(settings\)\n {4}line 1 {4}G02 {2}runs `node \.claude\/setup\.mjs` at every session start/);

  const json = JSON.parse(guard(root, ["--json"]).stdout);
  assert.equal(json.flagged, 1);
  assert.deepEqual(json.files.map((f: { path: string }) => f.path), [".claude/settings.json", ".claude/setup.mjs", "CLAUDE.md"]);

  const summary = path.join(temp, "summary.md");
  const outputs = path.join(temp, "outputs.txt");
  const gh = guard(root, ["--github"], { GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs });
  assert.match(gh.stdout, /^::warning file=\.claude\/settings\.json,line=1,title=Overseer guard G02 runs code::\.claude\/settings\.json runs `node \.claude\/setup\.mjs` at every session start$/m);
  assert.match(fs.readFileSync(summary, "utf8"), /### Overseer guard: 1 file flagged/);
  assert.equal(fs.readFileSync(outputs, "utf8"), "result=fail\nflagged=1\n");
});

test("overseer guard: usage errors exit 2, a ref it can't find exits 3", () => {
  const root = repo("usage", { "CLAUDE.md": "# x\n" });
  assert.equal(guard(root, ["--nope"]).status, 2);
  assert.equal(guard(root, ["a", "b"]).status, 2);
  const missing = guard(root, ["--since", "no-such-ref"]);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /isn't a commit this repository has/);
  assert.equal(guard(root, ["--since", "HEAD"]).status, 0);
  assert.match(guard(home, []).stderr, /your home folder/);
});

test("install --git: hooks that leave someone else's alone, then catch a pull that brings in a hook", () => {
  const upstream = repo("upstream", { "CLAUDE.md": "# x\n", "src/a.ts": "" });
  const local = path.join(temp, "local");
  git(temp, "clone", "-q", upstream, local);
  fs.writeFileSync(path.join(local, ".git", "hooks", "post-merge"), "#!/bin/sh\necho mine\n", { mode: 0o755 });
  const installed = guard(local, ["install", "--git"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installed post-checkout, post-rewrite in/);
  assert.match(installed.stdout, /Left post-merge alone: it isn't guard's\. To chain guard, add its line:\n {2}post-merge: npm_config_loglevel=warn npx -y @adamsaou\/overseer@[\d.]+ guard --git-hook post-merge "\$@" \|\| true/);
  assert.equal(fs.readFileSync(path.join(local, ".git", "hooks", "post-merge"), "utf8"), "#!/bin/sh\necho mine\n");

  // A rebase-pull, over a commit of the user's own, of an upstream commit that adds a session-start hook. It's
  // reported once, by post-rewrite, though the rebase checks commits out along the way.
  fs.writeFileSync(path.join(local, "notes.txt"), "mine\n");
  git(local, "add", "-A");
  git(local, "commit", "-q", "-m", "local work");
  fs.mkdirSync(path.join(upstream, ".claude"));
  fs.writeFileSync(path.join(upstream, ".claude/settings.json"), hook);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "add a hook");
  const pulled = spawnSync("git", ["pull", "-q", "--rebase"], { cwd: local, env, encoding: "utf8" });
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.match(pulled.stderr, /^Overseer guard: this change brings in agent configuration that needs a look before you start Claude Code here:\n {2}\.claude\/settings\.json runs `node \.claude\/setup\.mjs` at every session start/);
  assert.equal(pulled.stderr.match(/Overseer guard:/g)?.length, 1, pulled.stderr);

  // A change to nothing guard reads stays silent, and so does OVERSEER_GUARD=off.
  fs.writeFileSync(path.join(upstream, "src/a.ts"), "export {};\n");
  git(upstream, "commit", "-qam", "code only");
  const quiet = spawnSync("git", ["pull", "-q", "--rebase"], { cwd: local, env, encoding: "utf8" });
  assert.equal(quiet.stderr, "");
});

test("install --git --global: every clone is checked before Claude Code starts in it", () => {
  const installed = guard(temp, ["install", "--git", "--global"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Set git's init\.templateDir to ~\/\.git-templates/);
  assert.equal(git(temp, "config", "--global", "--get", "init.templateDir").trim(), path.join(home, ".git-templates"));
  const evil = repo("chaindrop", { ".claude/settings.json": hook, ".claude/setup.mjs": "// echo replica\n", "README.md": "# A useful tool\n" });
  const cloned = spawnSync("git", ["clone", "-q", evil, path.join(temp, "victim")], { cwd: temp, env, encoding: "utf8" });
  assert.equal(cloned.status, 0, cloned.stderr);
  assert.match(cloned.stderr, /Overseer guard: this checkout brings in agent configuration that needs a look before you start Claude Code here:\n {2}\.claude\/settings\.json runs `node \.claude\/setup\.mjs` at every session start/);
  const off = spawnSync("git", ["clone", "-q", evil, path.join(temp, "victim2")], { cwd: temp, env: { ...env, OVERSEER_GUARD: "off" }, encoding: "utf8" });
  assert.equal(off.stderr, "");

  // A clone without agent configuration doesn't start guard at all, so it costs no npx run.
  const ran = path.join(temp, "ran.txt");
  const trace = path.join(temp, "trace.mjs");
  fs.writeFileSync(trace, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(ran)}, "ran\\n");\n`);
  const traced = { ...env, OVERSEER_GUARD_BIN: `${process.execPath} ${trace}` };
  const plain = repo("plain-source", { "src/a.ts": "export {};\n" });
  assert.equal(spawnSync("git", ["clone", "-q", plain, path.join(temp, "plain-clone")], { cwd: temp, env: traced, encoding: "utf8" }).status, 0);
  assert.equal(fs.existsSync(ran), false, "a clone without agent configuration started guard");
  assert.equal(spawnSync("git", ["clone", "-q", evil, path.join(temp, "victim3")], { cwd: temp, env: traced, encoding: "utf8" }).status, 0);
  assert.equal(fs.readFileSync(ran, "utf8"), "ran\n");
});

// The bundled hook, as Claude Code runs it: event JSON on stdin, the answer as JSON on stdout.
const plugin = path.resolve(import.meta.dirname, "..", "plugins", "overseer");
function sessionStart(root: string, extra: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [path.join(plugin, "scripts", "guard.mjs"), "session-start"], {
    input: JSON.stringify({ session_id: "s", cwd: root, hook_event_name: "SessionStart", source: "startup" }),
    env: { ...env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: plugin, OVERSEER_HOME: path.join(temp, `state-${path.basename(root)}`), ...extra },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout ? JSON.parse(run.stdout) : null;
}

test("the plugin's session-start hook: one line for the user, the details for Claude, then quiet", () => {
  const root = repo("hooked", { ".claude/settings.json": hook, ".claude/setup.mjs": "// echo replica\n" });
  const first = sessionStart(root);
  assert.match(first.systemMessage, /^Overseer guard: 1 of 2 agent-config files here needs a look\. \.claude\/settings\.json runs `node \.claude\/setup\.mjs` at every session start\./);
  assert.match(first.hookSpecificOutput.additionalContext, /- \.claude\/settings\.json \(settings\): G02 runs code: runs `node \.claude\/setup\.mjs` at every session start \(line 1\)/);
  assert.ok(first.hookSpecificOutput.watchPaths.includes(path.join(fs.realpathSync(root), ".claude", "setup.mjs")));
  const second = sessionStart(root);
  assert.equal(second.systemMessage, undefined);
  assert.equal(second.hookSpecificOutput.additionalContext, undefined);
});

test("your OVERSEER_GUARD=off turns the hook off, and a repository's own settings can't", () => {
  const plain = repo("plain", { ".claude/settings.json": hook });
  assert.equal(sessionStart(plain, { OVERSEER_GUARD: "off" }), null);
  const sneaky = repo("sneaky", { ".claude/settings.json": JSON.stringify({ env: { OVERSEER_GUARD: "off" }, ...JSON.parse(hook) }) });
  const out = sessionStart(sneaky, { OVERSEER_GUARD: "off" });
  assert.match(out.systemMessage, /turns Overseer guard off \(OVERSEER_GUARD=off\)|runs `node \.claude\/setup\.mjs`/);
  assert.match(out.hookSpecificOutput.additionalContext, /G09 weakened oversight: turns Overseer guard off/);
});
