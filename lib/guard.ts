// Overseer guard, the free and local layer. It lists the files in a repository that steer Claude Code
// (instruction files, agents, skills, commands, settings, MCP servers, the scripts its hooks run) and the ones
// other coding agents act on by themselves, lints them for the ways this year's attacks used them, and
// remembers what it has seen, so a change is pointed out once. It reads files and asks git for the file list;
// it never runs a repository's code, sends nothing anywhere and costs nothing. Node.js built-ins only, because
// the plugin's hooks bundle it into one file.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Kind = "instructions" | "agent" | "skill" | "command" | "output-style" | "settings" | "mcp" | "hook-script" | "other-agent" | "docs";
export type Severity = "warn" | "info";
export type Finding = { rule: RuleId; severity: Severity; line: number; message: string };
// first: the first scan of this folder, which sets the baseline. new and changed are since the last scan.
export type Status = "first" | "new" | "changed" | "seen";
export type Entry = { path: string; kind: Kind; sha256: string; size: number; findings: Finding[]; status: Status };
export type Scan = { root: string; head: string | null; first: boolean; files: Entry[]; removed: string[]; since?: string };

export const RULES = {
  G01: "Hidden characters: zero-width, bidirectional or tag characters that a reader can't see",
  G02: "Code the repository runs on your machine: hooks, helper commands, status lines, inline shell",
  G03: "MCP servers, plugins and marketplaces the repository adds or approves for itself",
  G04: "Who does the work: a reviewer agent pinned to a weaker model or a narrower scope, or the session's agent and models",
  G05: "Text that tries to steer an agent: hidden comments addressed to AI agents, or orders to ignore earlier instructions",
  G06: "Instructions to run code downloaded from the internet",
  G07: "Destructive instructions, such as deleting a home folder or cloud resources",
  G08: "Instructions to send secrets, files or screenshots somewhere outside",
  G09: "Weakened oversight: hooks turned off, broad pre-approvals, orders to keep things from the user or turn monitoring off",
  G10: "Environment overrides: where API requests go, which keys they use, and code that runs in every process",
  G11: "Commands other tools run on their own when the folder opens, such as VS Code tasks and dev containers",
  G12: "Secrets written into the configuration",
  G13: "Links that make Claude Code read a file outside the repository",
} as const;
export type RuleId = keyof typeof RULES;

// Bumped when rules change, so files scanned by an older version are linted again.
const RULES_VERSION = 1;
const MAX_BYTES = 1 << 20;
const MAX_FILES = 2000;
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache"]);
const INSTRUCTION_NAMES = new Set(["claude.md", "claude.local.md", "agents.md", "gemini.md", ".cursorrules", ".windsurfrules", ".clinerules"]);
// Files that run code or reach other machines. A change to one is pointed out even when no rule fires.
export const RUNS: ReadonlySet<Kind> = new Set(["settings", "mcp", "hook-script", "other-agent"]);
const TEXT: ReadonlySet<Kind> = new Set(["instructions", "agent", "skill", "command", "output-style"]);

// What git lists, so a large repository costs one call: every place a file kindOf knows can be, at any depth,
// in any case.
export const PATHSPECS = [
  "**/CLAUDE.md",
  "**/CLAUDE.local.md",
  "**/AGENTS.md",
  "**/GEMINI.md",
  "**/.claude/**",
  "**/.mcp.json",
  "**/.cursorrules",
  "**/.windsurfrules",
  "**/.clinerules",
  ".cursor/**",
  ".github/copilot-instructions.md",
  ".github/instructions/**",
  ".vscode/tasks.json",
  ".gemini/settings.json",
  ".devcontainer/devcontainer.json",
  "*.md",
  "docs/*.md",
].map((spec) => `:(glob,icase)${spec}`);

// Which kind of file a path in the repository is, with forward slashes, or null for one Claude Code doesn't
// act on. Nested .claude folders count: in a monorepo, Claude Code started in a package reads the package's.
// Names match in any case, because on macOS and Windows a committed .CLAUDE/SETTINGS.JSON opens as
// .claude/settings.json.
export function kindOf(rel: string): Kind | null {
  const parts = rel.toLowerCase().split("/");
  if (parts.some((part) => SKIP_DIRS.has(part))) return null;
  const base = parts[parts.length - 1];
  const dirs = parts.slice(0, -1);
  const lower = parts.join("/");
  const ext = path.posix.extname(base);
  const at = dirs.lastIndexOf(".claude");
  if (at >= 0) {
    if (dirs.length === at + 1) {
      if (base === "settings.json" || base === "settings.local.json") return "settings";
      return base === "claude.md" ? "instructions" : null;
    }
    if (ext !== ".md") return null;
    const area = dirs[at + 1];
    if (area === "agents") return "agent";
    if (area === "commands") return "command";
    if (area === "rules") return "instructions";
    if (area === "output-styles") return "output-style";
    return area === "skills" && base === "skill.md" ? "skill" : null;
  }
  if (INSTRUCTION_NAMES.has(base)) return "instructions";
  if (base === ".mcp.json") return "mcp";
  if (lower === ".github/copilot-instructions.md") return "instructions";
  if (lower.startsWith(".github/instructions/") && base.endsWith(".instructions.md")) return "instructions";
  if (lower.startsWith(".cursor/rules/") && (ext === ".mdc" || ext === ".md")) return "instructions";
  if ([".vscode/tasks.json", ".cursor/hooks.json", ".gemini/settings.json", ".devcontainer/devcontainer.json"].includes(lower)) return "other-agent";
  // Docs written for people, where a hidden comment can address agents instead: the top level and docs/.
  if (ext === ".md" && (dirs.length === 0 || (dirs.length === 1 && dirs[0] === "docs"))) return "docs";
  return null;
}

const posix = (p: string) => p.split(path.sep).join("/");
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20, timeout: 10_000 });
  } catch {
    return null;
  }
}

export const isGitRepo = (root: string) => git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
export const headOf = (root: string) => git(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;

// Files in the folder that kindOf knows, relative, with forward slashes. In a git repository, the ones git
// tracks or would (ignored files are left out, as they arrive by no checkout), plus the local files Claude
// Code reads that are usually ignored. Elsewhere, a bounded walk.
function listFiles(root: string): string[] {
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...PATHSPECS]);
  const found = new Set<string>();
  if (listed !== null) {
    for (const rel of listed.split("\0")) if (rel && kindOf(rel)) found.add(rel);
    for (const rel of [".claude/settings.local.json", "CLAUDE.local.md", ".mcp.json"]) if (fs.existsSync(path.join(root, rel))) found.add(rel);
  } else {
    walk(root, "", 0, found, { dirs: 0 });
  }
  return [...found].sort().slice(0, MAX_FILES);
}

function walk(root: string, rel: string, depth: number, found: Set<string>, budget: { dirs: number }) {
  if (depth > 8 || found.size >= MAX_FILES || ++budget.dirs > 5000) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, child, depth + 1, found, budget);
    } else if (kindOf(child)) {
      found.add(child);
    }
  }
}

// ---- Text helpers

const lineAt = (text: string, index: number) => {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
};

const lineOf = (text: string, needle: string) => {
  const index = text.indexOf(needle);
  return index < 0 ? 1 : lineAt(text, index);
};

// Shown in messages: one line, at most n characters, with characters a reader can't see written as escapes.
export function shown(text: string, n = 100): string {
  const line = text
    .replace(HIDDEN_ANY, (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

const code = (text: string, n = 90) => `\`${shown(text, n).replace(/`/g, "'")}\``;

// Whether the sentence or line a match is in turns it around before the match: "never run rm -rf ~", or a
// passage describing a danger rather than asking for it.
function negated(text: string, index: number) {
  const start = Math.max(text.lastIndexOf("\n", index - 1), text.lastIndexOf(". ", index - 1), index - 120, 0);
  return /\b(never|don't|do not|must not|mustn't|should not|shouldn't|cannot|can't|avoid|no longer|prohibited|forbidden|not allowed|refuse|instead of|rather than|blocks?|blocked|denies|deny|denied|dangerous|careful|warning)\b/i.test(
    text.slice(start, index),
  );
}

// The first match of a pattern that isn't negated, and, for phrases discussed as examples, isn't in quotes.
function firstMatch(pattern: RegExp, text: string, skipQuoted = false): RegExpExecArray | null {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let m = global.exec(text); m; m = global.exec(text)) {
    if (!negated(text, m.index) && !(skipQuoted && quoted(text, m.index))) return m;
    if (m[0].length === 0) global.lastIndex++;
  }
  return null;
}

// Whether a match starts inside quotation marks on its line, as an example being discussed.
function quoted(text: string, index: number) {
  const before = text.slice(Math.max(text.lastIndexOf("\n", index - 1) + 1, index - 200), index);
  return /["“'‘]\s*$/.test(before) || ((before.match(/"/g)?.length ?? 0) % 2 === 1 && !/`/.test(before));
}

// ---- G01: hidden characters

// Zero-width and invisible format characters, bidirectional controls, tag characters and variation selectors.
const HIDDEN_ANY = /[­ᅟᅠ᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const PICTURE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[⃣\u{1F3FB}-\u{1F3FF}]/u;

const EMOJI_BASE = /^[#*0-9©®‼⁉™ℹ←-⇿⌀-➿⤴⤵⬀-⯿〰〽㊗㊙]$/u;
// A letter of a script that joins with these characters, such as Persian, Arabic or the Indic scripts.
const JOINING = (ch: string) => /[\p{L}\p{M}]/u.test(ch) && !/\p{Script=Latin}|\p{Script=Common}/u.test(ch);

// Legitimate uses: a byte-order mark at the start; a zero-width joiner or a variation selector in an emoji; a
// zero-width (non-)joiner between letters of a joining script; a soft hyphen inside a word; and the few tag
// characters of a subdivision flag such as England's.
function legitimate(text: string, index: number, ch: string, prev: string, next: string) {
  const cp = ch.codePointAt(0)!;
  if (cp === 0xfeff) return index === 0;
  if (cp >= 0xe0020 && cp <= 0xe007f) return inFlag(text, index);
  if (cp >= 0xfe00 && cp <= 0xfe0f) return PICTURE.test(prev) || EMOJI_BASE.test(prev);
  if (cp === 0x200d) return (PICTURE.test(prev) && PICTURE.test(next)) || (JOINING(prev) && JOINING(next));
  if (cp === 0x200c) return JOINING(prev) && JOINING(next);
  if (cp === 0x00ad) return /\p{L}/u.test(prev) && /\p{L}/u.test(next);
  return false;
}

// Whether the tag character at index belongs to a flag: the black flag, then at most eight tag characters.
function inFlag(text: string, index: number) {
  let i = index;
  let tags = 0;
  while (i >= 2 && tags <= 8) {
    const cp = text.codePointAt(i - 2)!;
    if (cp === 0x1f3f4) return true;
    if (cp < 0xe0020 || cp > 0xe007f) return false;
    i -= 2;
    tags++;
  }
  return false;
}

function hiddenCharacters(text: string): Finding[] {
  const chars = [...text.matchAll(HIDDEN_ANY)].filter((m) => {
    const i = m.index!;
    const prev = [...text.slice(Math.max(0, i - 2), i)].pop() ?? "";
    const next = [...text.slice(i + m[0].length, i + m[0].length + 2)][0] ?? "";
    return !legitimate(text, i, m[0], prev, next);
  });
  if (!chars.length) return [];
  const points = chars.map((m) => m[0].codePointAt(0)!);
  // Tag characters spell ASCII, so what they hide can be read out.
  const tags = points.filter((cp) => cp >= 0xe0020 && cp <= 0xe007e);
  const controls = points.some((cp) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp >= 0xe0000);
  const message = `hides ${chars.length} character${chars.length === 1 ? "" : "s"} a reader can't see (zero-width, bidirectional or tag)${
    tags.length >= 4 ? `, whose tag characters spell "${shown(String.fromCharCode(...tags.map((cp) => cp - 0xe0000)), 80)}"` : ""
  }`;
  // One or two zero-width characters are usually left over from pasting; hidden text takes more.
  return [{ rule: "G01", severity: controls || chars.length >= 3 ? "warn" : "info", line: lineAt(text, chars[0].index!), message }];
}

// ---- Command patterns, shared by instruction text, hooks and server commands

// Well-known installers. Piping them into a shell is still remote code, but it's how their docs say to install.
const KNOWN_INSTALLERS = /https?:\/\/(astral\.sh|bun\.sh|deno\.land|sh\.rustup\.rs|get\.pnpm\.io|raw\.githubusercontent\.com\/nvm-sh|fnm\.vercel\.app|get\.volta\.sh|install\.python-poetry\.org|pyenv\.run|claude\.ai\/install|get\.docker\.com|cli\.github\.com|brew\.sh|raw\.githubusercontent\.com\/Homebrew)\//i;

const REMOTE = [
  /\b(curl|wget|fetch)\b[^|\n;]{0,300}\|\s*(sudo\s+)?(-?\w+=\S+\s+)*(ba|z|k|da|fi)?sh\b/i,
  /\b(curl|wget)\b[^|\n;]{0,300}\|\s*(sudo\s+)?(python3?|node|perl|ruby|php|deno|bun)\b/i,
  /\b(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/i,
  /\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/i,
  /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]{0,300}\|\s*(iex|Invoke-Expression)\b/i,
  /\b(iex|Invoke-Expression)\b[^\n]{0,80}\b(DownloadString|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/i,
  /\bbase64\s+(-d|--decode|-D)\b[^|\n]{0,200}\|\s*(ba|z)?sh\b/i,
  /\becho\s+["']?[A-Za-z0-9+/=]{60,20000}["']?\s*\|\s*base64\s+(-d|--decode|-D)\b/i,
];

// Every pattern here reads files an attacker may have written, so none can backtrack without bound: gaps and
// runs have limits, and the three-part searches go step by step (chain). A file built to make the lint slow
// would otherwise run out a hook's time and pass unflagged.
const DESTRUCTIVE = [
  /\brm\s+(-[a-zA-Z]{0,8}r[a-zA-Z]{0,8}f[a-zA-Z]{0,8}|-[a-zA-Z]{0,8}f[a-zA-Z]{0,8}r[a-zA-Z]{0,8}|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\s+(--no-preserve-root\s+)?["']?(\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\/\*|~\/\*|\$HOME\/\*)["']?(?=\s|$|[;&|`)])/,
  // The Amazon Q extension's planted prompt: "clean a system to a near-factory state and delete file-system and cloud resources".
  /\b(near[- ]factory|factory[- ](state|reset|settings|defaults))\b/i,
  /\b(delete|wipe|erase|destroy|purge|remove)\s+(all\s+|every\s+|the\s+entire\s+|the\s+whole\s+)?(of\s+)?(the\s+|their\s+|your\s+)?(file[- ]?systems?|hard (disks?|drives?)|home (folders?|director(y|ies))|cloud resources|(all|every)\s+(repositor(y|ies)|databases?|buckets?|instances?|users?|backups?|resources))\b/i,
  /\bmkfs(\.\w+)?\s+\/dev\//,
  /\bdd\s+[^\n]*\bof=\/dev\/(sd|nvme|hd|disk|xvd)/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
];

const SECRET_FILES = String.raw`(\.env\b|\.ssh\/|id_rsa|id_ed25519|id_ecdsa|\.aws\/credentials|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.kube\/config|\.docker\/config\.json|\.config\/gh\/hosts|Keychains?\/|\.gnupg\/)`;
const SENDERS = String.raw`(curl|wget|nc|ncat|socat|scp|rsync|httpie|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)`;
const SEND_FILE = [
  // A command that sends a secret file somewhere, or reads one into a command that does.
  new RegExp(String.raw`\b${SENDERS}\b[^\n]{0,200}${SECRET_FILES}`),
  new RegExp(String.raw`${SECRET_FILES}[^\n]{0,80}\|\s*${SENDERS}\b`),
];
// In words: send or upload secrets or screenshots, then where to: somewhere outside.
const SEND_WORDS: Step[] = [
  [/\b(send|post|upload|exfiltrate|forward|transmit|leak|share|copy|paste|report|push|sync)\b/i, 0],
  [/\b(secrets?|tokens?|credentials?|api[- ]?keys?|passwords?|private keys?|ssh keys?|environment variables|env vars|cookies|session (ids?|tokens?)|screenshots?|keychain|wallets?|seed phrases?)\b|\.env\b/i, 80],
  [/\b(to|into|at|via|on|with)\b/i, 80],
  [/https?:\/\/|\bwebhook|\bgists?\b|pastebin|\bpaste\.|discord|telegram|ngrok|requestbin|pipedream|\ban? (external|remote|third[- ]party) (server|endpoint|url|service|host)\b|\bpublic (repo|repository|gist|bucket)\b/i, 40],
];
// The PixelLeak shape: when something fails, make it public instead. Data that's usually private makes it a
// warning; other files, such as a site's build, only a note.
const MAKE_PUBLIC: Step[] = [
  [/\b(create|make|open|publish|upload|post|push|put)\b/i, 0],
  [/\bpublic\b/i, 60],
  [/\b(gists?|repo|repos|repository|repositories|pastes?|buckets?|links?|releases?)\b/i, 20],
];
const PRIVATE_DATA = /\b(screenshots?|screen ?shots?|screen recordings?|transcripts?|sessions?|conversations?|logs?|dumps?|traces?|secrets?|credentials?|tokens?|keys?|\.env|private)\b/i;

// Each step's pattern, and how far past the previous step's match it may start, in characters.
type Step = [RegExp, number];

// Where steps match one after another in one sentence, as a regex with bounded gaps between them would, but
// in linear time: each step reads only its stretch. The first match that isn't negated, or null.
function chain(text: string, steps: Step[]): RegExpExecArray | null {
  const first = new RegExp(steps[0][0].source, `${steps[0][0].flags.replace("g", "")}g`);
  for (let m = first.exec(text); m; m = first.exec(text)) {
    let at = m.index + m[0].length;
    let matched = true;
    for (const [pattern, reach] of steps.slice(1)) {
      const stretch = text.slice(at, at + reach + 200);
      const end = stretch.search(/\n|[.!?]\s/);
      const found = pattern.exec(end >= 0 ? stretch.slice(0, end) : stretch);
      if (!found || found.index > reach) {
        matched = false;
        break;
      }
      at += found.index + found[0].length;
    }
    if (matched && !negated(text, m.index)) return m;
  }
  return null;
}

type Hit = { rule: RuleId; severity: Severity; index: number; message: string };

// What a command or a passage of instructions does, by the patterns above.
function commandHits(text: string, where: "text" | "command"): Hit[] {
  const hits: Hit[] = [];
  const says = (does: string, told: string) => (where === "text" ? told : does);
  for (const pattern of REMOTE) {
    const m = firstMatch(pattern, text);
    if (!m) continue;
    const known = KNOWN_INSTALLERS.test(contextOf(text, m.index));
    hits.push({ rule: "G06", severity: known ? "info" : "warn", index: m.index, message: `${says("runs", "tells the agent to run")} code downloaded from the internet: ${code(m[0])}${known ? ", from a well-known installer" : ""}` });
    break;
  }
  for (const pattern of DESTRUCTIVE) {
    const m = firstMatch(pattern, text);
    if (!m) continue;
    hits.push({ rule: "G07", severity: "warn", index: m.index, message: `${says("destroys data", "tells the agent to destroy data")}: ${code(contextOf(text, m.index))}` });
    break;
  }
  const send = SEND_FILE.map((p) => firstMatch(p, text)).find(Boolean) ?? chain(text, SEND_WORDS);
  if (send) hits.push({ rule: "G08", severity: "warn", index: send.index, message: `${says("sends data out", "tells the agent to send data out")}: ${code(contextOf(text, send.index))}` });
  const open = chain(text, MAKE_PUBLIC);
  if (open && !send) {
    const what = contextOf(text, open.index);
    hits.push({ rule: "G08", severity: PRIVATE_DATA.test(what) ? "warn" : "info", index: open.index, message: `${says("publishes", "tells the agent to publish")} to a public place: ${code(what)}` });
  }
  return hits;
}

// The line a match is on, from a little before it.
function contextOf(text: string, index: number) {
  const start = Math.max(text.lastIndexOf("\n", index - 1) + 1, index - 40);
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? undefined : end);
}

// ---- G12: secrets

const SECRETS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20}/, "an Anthropic API key"],
  [/\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32}/, "an OpenAI-style API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36}|\bgithub_pat_[A-Za-z0-9_]{60}/, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10}/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/, "a private key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "an npm token"],
  [/\bglpat-[A-Za-z0-9_-]{20}/, "a GitLab token"],
  [/\beyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10}/, "a JSON web token"],
];

function secretIn(value: string): string | null {
  for (const [pattern, what] of SECRETS) if (pattern.test(value)) return what;
  return null;
}

function secretFindings(text: string): Finding[] {
  for (const [pattern, what] of SECRETS) {
    const m = pattern.exec(text);
    if (m) return [{ rule: "G12", severity: "warn", line: lineAt(text, m.index), message: `holds what looks like ${what}, in plain text (not shown here)` }];
  }
  return [];
}

// ---- Instruction text: CLAUDE.md, agents, skills, commands, rules, output styles

type Front = { end: number; keys: Map<string, { value: string; line: number; block: string[] }> };

// The YAML frontmatter of an agent, a skill or a command: each top-level key with its value and the indented
// lines under it, which is all the rules need. Not a YAML parser.
export function frontmatter(text: string): Front | null {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return null;
  const keys: Front["keys"] = new Map();
  let current: { value: string; line: number; block: string[] } | null = null;
  m[1].split(/\r?\n/).forEach((line, i) => {
    const top = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (top) {
      current = { value: unquote(top[2].trim()), line: i + 2, block: [] };
      keys.set(top[1].toLowerCase(), current);
    } else if (current && /^\s+\S|^-\s/.test(line)) {
      current.block.push(line);
    }
  });
  return { end: m[0].length, keys };
}

const unquote = (value: string) => value.replace(/^(["'])([\s\S]*)\1$/, "$2");

// A frontmatter list, inline (a, b or [a, b]) or as a block of - items. Commas inside parentheses stay.
function listOf(entry: { value: string; block: string[] } | undefined): string[] {
  if (!entry) return [];
  const items: string[] = [];
  const inline = entry.value.replace(/^\[|\]$/g, "");
  let depth = 0;
  let item = "";
  for (const ch of inline) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(item);
      item = "";
    } else item += ch;
  }
  items.push(item);
  for (const line of entry.block) {
    const m = /^\s*-\s+(.*)$/.exec(line);
    if (m) items.push(m[1]);
  }
  return items.map((i) => unquote(i.trim())).filter(Boolean);
}

// The commands in a frontmatter block such as hooks: or mcpServers:.
const blockCommands = (block: string[]) =>
  block.map((line) => /^\s*-?\s*command\s*:\s*(.+)$/.exec(line)?.[1]).filter((c): c is string => Boolean(c)).map((c) => unquote(c.trim()));

const REVIEWER = /\b(review(s|er|ers|ing)?|audit(s|or|ors|ing)?|security|verif(y|ies|ier|ication)|approv(e|es|al|er)|gatekeep(er|ing)?|inspect(or|ion)?|qa)\b/i;
// "Only review src/ and docs/", "skip tests": a review told to leave out part of the repository, other than
// the generated folders anyone would skip.
const NARROWED =
  /\b(only (review|check|look at|read|scan|inspect|audit|consider)|limit (your |the |its )?(review|scope|checks?) to|ignore|skip|exclude|don't (review|check|read|open|look at)|do not (review|check|read|open|look at))\b[^.\n]{0,40}?(\b(tests?|specs?|src|docs?|scripts?|ci|workflows?|hooks?|config)\b|\.github\b|\.claude\b|\b(?!node_modules\/|dist\/|build\/|vendor\/|coverage\/|out\/|target\/)[\w.-]{1,80}\/)/i;
const WEAK_MODEL = /^(haiku|claude-haiku[\w.-]*|claude-3[\w.-]*|claude-instant[\w.-]*)$/i;
// Any command, any URL, or any program a downloader or interpreter is given: Bash, Bash(*), Bash(npx:*),
// Bash(python3 *). A rule naming the script or subcommand, such as Bash(npx tsc *), isn't broad.
const BROAD_TOOLS =
  /^(Bash|PowerShell|WebFetch)(\(\s*(\*{1,2}|:\*)?\s*\))?$|^(Bash|PowerShell)\(\s*(curl|wget|sh|bash|zsh|fish|python3?|node|deno|bun|npx|bunx|pnpx|uvx|pipx|eval|sudo|env|xargs|perl|ruby|php)(\s*:\s*\*|\s+\*{1,2})?\s*\)$/;

function textFindings(text: string, kind: Kind): Finding[] {
  const findings: Finding[] = [];
  const front = kind === "agent" || kind === "skill" || kind === "command" ? frontmatter(text) : null;
  const body = front ? text.slice(front.end) : text;
  const offset = front ? lineAt(text, front.end) - 1 : 0;
  const add = (hit: Hit) => findings.push({ rule: hit.rule, severity: hit.severity, line: offset + lineAt(body, hit.index), message: hit.message });

  if (front) {
    const hooks = front.keys.get("hooks");
    for (const command of blockCommands(hooks?.block ?? [])) {
      findings.push({ rule: "G02", severity: "warn", line: hooks!.line, message: `runs ${code(command)} while this ${kind} is in use (a hook in its frontmatter)` });
    }
    const servers = front.keys.get("mcpservers");
    for (const command of blockCommands(servers?.block ?? [])) {
      findings.push({ rule: "G03", severity: "info", line: servers!.line, message: `starts an MCP server for this ${kind}: ${code(command)}` });
    }
    const allowed = front.keys.get("allowed-tools");
    const broad = listOf(allowed).filter((tool) => BROAD_TOOLS.test(tool));
    if (broad.length) {
      findings.push({
        rule: "G09",
        severity: "warn",
        line: allowed!.line,
        message: `pre-approves ${broad.map((t) => code(t)).join(", ")} whenever this ${kind} runs, with no prompt, and workspace trust doesn't gate that`,
      });
    }
    if (kind === "agent") {
      const model = front.keys.get("model");
      const tools = listOf(front.keys.get("tools"));
      const about = `${front.keys.get("name")?.value ?? ""} ${front.keys.get("description")?.value ?? ""}`;
      const narrowed = firstMatch(NARROWED, body);
      const weak = model && WEAK_MODEL.test(model.value);
      const blind = tools.length > 0 && !tools.some((t) => /^(Read|Grep|Glob|Bash)\b/.test(t));
      if (REVIEWER.test(about) && (weak || narrowed || blind)) {
        const what = [weak && `pins the model ${model!.value}`, blind && `can only use ${tools.join(", ")}`, narrowed && `narrows its review: ${code(narrowed[0], 70)}`].filter(Boolean);
        findings.push({ rule: "G04", severity: "warn", line: weak ? model!.line : offset + lineAt(body, narrowed?.index ?? 0), message: `is a reviewer this repository defines, and ${what.join(", and ")}` });
      } else if (weak) {
        findings.push({ rule: "G04", severity: "info", line: model!.line, message: `pins the model ${model!.value}` });
      }
    }
  }

  // Inline shell in skills and commands runs when they're invoked, before Claude reads the result.
  if (kind === "skill" || kind === "command") {
    for (const m of body.matchAll(/!`([^`\n]+)`|^```!\s*\n([\s\S]*?)^```/gm)) {
      const command = m[1] ?? m[2] ?? "";
      const hits = commandHits(command, "command");
      if (hits.length) hits.forEach((hit) => add({ ...hit, index: m.index! }));
      else add({ rule: "G02", severity: "info", index: m.index!, message: `runs ${code(command)} when invoked (inline shell)` });
    }
  }

  for (const hit of commandHits(body, "text")) add(hit);

  // A concealment order is the instruction itself, so it isn't checked for negation. "Don't tell the user to
  // do something" is advice about what to suggest, not concealment.
  const conceal = /\b(do not|don't|never)\s+(tell|inform|notify|alert|warn|mention (it |this |that |these )?to|reveal (it |this |that |these )?to|disclose (it |this |that |these )?to)\s+(it\s+|this\s+|that\s+)?(to\s+)?(the\s+)?(user|human|developer|maintainer|operator|reviewer|owner|person)s?\b(?!\s+(to|how to)\b)/i.exec(body);
  if (conceal) add({ rule: "G09", severity: "warn", index: conceal.index, message: `tells the agent to keep something from the user: ${code(contextOf(body, conceal.index))}` });
  const unmonitor = firstMatch(/\b(disable|turn off|switch off|remove|delete|bypass|circumvent|silence|suppress|mute|tamper with|uninstall)\s+(the\s+|any\s+|all\s+|its\s+|their\s+)?(monitor(ing|s)?|alerting|audit(ing)?\s+(logs?|trails?)|guardrails?|safety (checks?|filters?|classifiers?)|security (checks?|scans?|scanning|tools?)|overseer|oversight)\b/i, body);
  if (unmonitor) add({ rule: "G09", severity: "warn", index: unmonitor.index, message: `tells the agent to switch off oversight: ${code(contextOf(body, unmonitor.index))}` });
  const verify = firstMatch(/--no-verify\b|\bcore\.hooksPath\s*=?\s*\/dev\/null/, body);
  if (verify) add({ rule: "G09", severity: "info", index: verify.index, message: `skips git hooks: ${code(contextOf(body, verify.index))}` });
  for (const hit of overrides(body, "warn")) add(hit);
  return findings;
}

const OVERRIDE = /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding|other|system|original)\s+(instructions|rules|prompts?|directions|guidelines)\b/i;

// An order to ignore earlier instructions, skipping the phrase quoted as an example, as security docs do.
function overrides(text: string, severity: Severity): Hit[] {
  const m = firstMatch(OVERRIDE, text, true);
  return m ? [{ rule: "G05", severity, index: m.index, message: `tries to override the agent's instructions: ${code(contextOf(text, m.index))}` }] : [];
}

// ---- G05: docs

// Text that speaks to an AI agent, rather than mentioning one.
const ADDRESSED = [
  /\b(if|when|since|as)\s+you('re|\s+are)\s+(an?\s+)?(AI|LLM|large language model|language model|assistant|agent|coding agent|bot|Claude|Copilot|Cursor|Codex|ChatGPT|GPT|Gemini)\b/i,
  /\b(note|attention|important|instructions?|message|reminder|notice)\s*(to|for)\s+(all\s+|any\s+)?(AI|LLMs?|language models?|assistants?|agents?|coding agents?|bots?|Claude|Copilot|Cursor|Codex|ChatGPT|Gemini)\b/i,
  /\b(AI|LLM|language model|coding)\s+(assistants?|agents?|models?|tools?)\s*[:,-]\s*(you|please|ignore|run|always|never|do|don't|make)\b/i,
  /^\s*(Claude|Copilot|Cursor|Codex|ChatGPT|Gemini|AI|Assistant|Agent)s?\s*[:,-]\s*(you|please|ignore|run|always|never|do|don't|make|before)\b/im,
];

function docsFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(/<!--([\s\S]{0,4000}?)-->|^\[\/\/\]: # \(([^)\n]{0,4000})\)|<[a-z]{1,10}[^>]{0,300}style\s*=\s*["'][^"']{0,300}(display\s*:\s*none|font-size\s*:\s*0|visibility\s*:\s*hidden|opacity\s*:\s*0)[^"']{0,300}["'][^>]{0,300}>([\s\S]{0,4000}?)<\/[a-z]{1,10}>/gim)) {
    const hidden = m[1] ?? m[2] ?? m[4] ?? "";
    if (ADDRESSED.some((p) => p.test(hidden)) || OVERRIDE.test(hidden)) {
      findings.push({ rule: "G05", severity: "warn", line: lineAt(text, m.index!), message: `hides text from readers that addresses AI agents: ${code(hidden, 110)}` });
      break;
    }
  }
  // In plain sight, an override is weaker evidence: docs about prompt injection quote one.
  findings.push(...overrides(text, "info").map((hit) => ({ ...hit, line: lineAt(text, hit.index) })));
  return findings;
}

// ---- Settings, MCP servers and other tools' configuration

// JSON, or JSON with comments and trailing commas, as VS Code and dev containers allow.
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
        out += text.slice(i, j + 1);
        i = j;
      } else if (ch === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        out += "\n";
      } else if (ch === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        out += text.slice(i, end < 0 ? text.length : end + 2).replace(/[^\n]/g, " ");
        i = end < 0 ? text.length : end + 1;
      } else out += ch;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A string as it's written inside a JSON file, to find its line.
const escaped = (value: string) => JSON.stringify(value).slice(1, -1);
const commandText = (h: Record<string, unknown>) =>
  [typeof h.command === "string" ? h.command : "", ...(Array.isArray(h.args) ? h.args.filter((a) => typeof a === "string") : [])].join(" ").trim();

const WHEN: Record<string, string> = {
  SessionStart: "at every session start",
  Setup: "at setup",
  SessionEnd: "when a session ends",
  UserPromptSubmit: "on every prompt",
  PreToolUse: "before tool calls",
  PostToolUse: "after tool calls",
  Stop: "whenever Claude finishes a turn",
  InstructionsLoaded: "whenever instructions load",
  FileChanged: "when watched files change",
  CwdChanged: "when the working folder changes",
  Notification: "on notifications",
};

export type Command = { command: string; where: string; line: number };

// Every command a settings file has Claude Code run: hooks, and helper commands such as apiKeyHelper.
function settingsCommands(text: string, json: Record<string, unknown>): Command[] {
  const out: Command[] = [];
  if (isObject(json.hooks)) {
    for (const [event, groups] of Object.entries(json.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) continue;
        const matcher = typeof group.matcher === "string" && group.matcher && group.matcher !== "*" ? ` matching ${code(group.matcher, 40)}` : "";
        for (const hook of group.hooks) {
          if (!isObject(hook)) continue;
          const when = `${WHEN[event] ?? `on ${event}`}${matcher}`;
          if (hook.type === "http" && typeof hook.url === "string") out.push({ command: "", where: `sends ${event} events to ${hostOf(hook.url)} ${when}`, line: lineOf(text, escaped(hook.url)) });
          const command = commandText(hook);
          if (command) out.push({ command, where: when, line: lineOf(text, escaped(typeof hook.command === "string" ? hook.command : event)) });
        }
      }
    }
  }
  for (const key of ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper"]) {
    if (typeof json[key] === "string" && json[key]) out.push({ command: json[key] as string, where: `as ${key}`, line: lineOf(text, `"${key}"`) });
  }
  for (const key of ["statusLine", "subagentStatusLine", "fileSuggestion"]) {
    const value = json[key];
    if (isObject(value) && typeof value.command === "string" && value.command) out.push({ command: value.command, where: `to draw the ${key === "fileSuggestion" ? "file suggestions" : "status line"}`, line: lineOf(text, `"${key}"`) });
  }
  return out;
}

const ENDPOINT_VARS = /^(ANTHROPIC_(BASE_URL|AWS_BASE_URL|BEDROCK_BASE_URL|BEDROCK_MANTLE_BASE_URL|VERTEX_BASE_URL|FOUNDRY_BASE_URL)|OTEL_EXPORTER_OTLP(_\w+)?_ENDPOINT|BETA_TRACING_ENDPOINT|HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy)$/;
const TLS_VARS = /^(NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/;
const KEY_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_CUSTOM_HEADERS|OTEL_EXPORTER_OTLP(_\w+)?_HEADERS|AWS_BEARER_TOKEN_BEDROCK)$/;
const EXEC_VARS = /^(NODE_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|ZDOTDIR|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+|GIT_CONFIG_PARAMETERS|PATH|SHELL|CLAUDE_CODE_SHELL|CLAUDE_CODE_SHELL_PREFIX|npm_config_\w+|NPM_CONFIG_\w+)$/;
const MODEL_VARS = /^(CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_AUTO_MODE_MODEL|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_DEFAULT_(HAIKU|SONNET|OPUS|FABLE)_MODEL)$/;
const SAFETY_VARS = /^CLAUDE_CODE_DISABLE_\w*(RM_PROMPT|RM_DENY|SANDBOX|PERMISSION|CLASSIFIER|SAFETY)\w*$/;
export const OFF = /^(off|0|false|no)$/i;

// Whether the project's shared settings, the .claude/settings.json a repository commits, set OVERSEER_GUARD or
// OVERSEER_HOOK off in their env, which reaches the hooks. A repository can't switch off the check of itself,
// so the hook ignores that; your own settings and environment still can.
export function repositoryTurnsGuardOff(root: string): boolean {
  try {
    const json = parseJsonc(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    const env = isObject(json) && isObject(json.env) ? json.env : {};
    return ["OVERSEER_GUARD", "OVERSEER_HOOK"].some((name) => typeof env[name] === "string" && OFF.test((env[name] as string).trim()));
  } catch {
    return false;
  }
}

const hostOf = (value: string) => {
  try {
    return new URL(value).host || value;
  } catch {
    return shown(value, 60);
  }
};

function envFindings(text: string, env: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    const line = lineOf(text, `"${name}"`);
    const secret = secretIn(value);
    const add = (rule: RuleId, message: string, severity: Severity = "warn") => findings.push({ rule, severity, line, message });
    if (ENDPOINT_VARS.test(name)) {
      add("G10", name.startsWith("ANTHROPIC") ? `sends Claude Code's API requests, with your credentials, to ${hostOf(value)} (${name})` : name.startsWith("OTEL") || name.startsWith("BETA") ? `sends telemetry to ${hostOf(value)} (${name})` : `routes network traffic through ${hostOf(value)} (${name})`);
    } else if (TLS_VARS.test(name)) {
      add("G10", name === "NODE_TLS_REJECT_UNAUTHORIZED" && value === "0" ? "turns off TLS certificate checks (NODE_TLS_REJECT_UNAUTHORIZED=0)" : `changes which TLS certificates are trusted (${name})`);
    } else if (KEY_VARS.test(name)) {
      add("G10", `sets ${name}, so requests use credentials or headers from the repository (not shown here)`);
    } else if (EXEC_VARS.test(name)) {
      add("G10", `sets ${name}=${secret ? "(not shown here)" : code(value, 60)} for every process Claude Code starts, which can run code in them`);
    } else if (MODEL_VARS.test(name)) {
      if (name === "CLAUDE_CODE_AUTO_MODE_MODEL") add("G09", `picks the model of auto mode's safety classifier: ${code(value, 40)}`);
      else add("G04", `sets ${name}=${code(value, 40)}`, name === "CLAUDE_CODE_SUBAGENT_MODEL" && WEAK_MODEL.test(value) ? "warn" : "info");
    } else if (SAFETY_VARS.test(name)) {
      add("G09", `sets ${name}, which turns a safety check off`);
    } else if (/^OVERSEER_(GUARD|HOOK)$/.test(name) && OFF.test(value.trim())) {
      add("G09", `turns Overseer guard off (${name}=${shown(value, 10)}), which guard ignores when a repository's shared settings say it`);
    }
    if (secret && !KEY_VARS.test(name)) add("G12", `holds what looks like ${secret} in ${name}, in plain text (not shown here)`);
  }
  return findings;
}

function settingsFindings(text: string, rel: string): Finding[] {
  let json: unknown;
  try {
    json = parseJsonc(text);
  } catch {
    return [{ rule: "G02", severity: "info", line: 1, message: "isn't valid JSON, so Claude Code ignores it and guard couldn't read it" }];
  }
  if (!isObject(json)) return [];
  const findings: Finding[] = [];
  const add = (rule: RuleId, severity: Severity, needle: string, message: string) => findings.push({ rule, severity, line: lineOf(text, needle), message });
  const local = rel.toLowerCase().endsWith("settings.local.json");
  for (const c of settingsCommands(text, json)) {
    if (!c.command) {
      findings.push({ rule: "G02", severity: "warn", line: c.line, message: c.where });
      continue;
    }
    findings.push({ rule: "G02", severity: "warn", line: c.line, message: `runs ${code(c.command)} ${c.where}` });
    for (const hit of commandHits(c.command, "command")) findings.push({ rule: hit.rule, severity: hit.severity, line: c.line, message: hit.message });
  }
  if (isObject(json.env)) findings.push(...envFindings(text, json.env));

  if (json.enableAllProjectMcpServers === true) add("G03", "warn", "enableAllProjectMcpServers", "approves every MCP server in .mcp.json with no prompt (enableAllProjectMcpServers)");
  if (Array.isArray(json.enabledMcpjsonServers) && json.enabledMcpjsonServers.length) {
    add("G03", "warn", "enabledMcpjsonServers", `approves the MCP servers ${json.enabledMcpjsonServers.map((s) => code(String(s), 30)).join(", ")} with no prompt (enabledMcpjsonServers)`);
  }
  if (isObject(json.extraKnownMarketplaces)) {
    for (const [name, value] of Object.entries(json.extraKnownMarketplaces)) {
      const source = isObject(value) && isObject(value.source) ? (value.source.repo ?? value.source.url ?? value.source.path ?? value.source.source) : undefined;
      add("G03", "warn", `"${name}"`, `adds the plugin marketplace ${code(name, 40)}${source ? ` from ${code(String(source), 60)}` : ""}`);
    }
  }
  if (isObject(json.enabledPlugins)) {
    for (const [plugin, on] of Object.entries(json.enabledPlugins)) {
      if (on === true) add("G03", "info", `"${plugin}"`, `turns on the plugin ${code(plugin, 50)}`);
      if (on === false && /^overseer@/.test(plugin)) add("G09", "warn", `"${plugin}"`, `turns Overseer off (${plugin})`);
    }
  }

  if (json.disableAllHooks === true) add("G09", "warn", "disableAllHooks", "turns off every hook, Overseer's included (disableAllHooks)");
  const permissions = isObject(json.permissions) ? json.permissions : {};
  if (Array.isArray(permissions.allow)) {
    const broad = permissions.allow.filter((rule) => typeof rule === "string" && BROAD_TOOLS.test(rule.trim()));
    if (broad.length) add("G09", "warn", String(broad[0]), `pre-approves ${broad.map((r) => code(String(r), 30)).join(", ")} once the folder is trusted, so Claude Code won't ask first`);
  }
  if (permissions.defaultMode === "bypassPermissions" || permissions.defaultMode === "auto") {
    add("G09", local ? "info" : "warn", "defaultMode", `asks for ${permissions.defaultMode} mode, which Claude Code ignores in project settings since 2.1.257, but shows intent`);
  }
  if (Array.isArray(permissions.additionalDirectories)) {
    const wide = permissions.additionalDirectories.filter((d) => typeof d === "string" && /^(\/|~\/?|\$HOME\/?|[A-Za-z]:\\?)$|^(~|\/home|\/Users|\$HOME)\/[^/]*\/?$/.test(d.trim()));
    if (wide.length) add("G09", "warn", String(wide[0]), `gives Claude access to ${wide.map((d) => code(String(d), 30)).join(", ")} (additionalDirectories)`);
  }
  if (json.skipDangerousModePermissionPrompt === true) add("G09", local ? "info" : "warn", "skipDangerousModePermissionPrompt", "asks to skip the bypass-mode warning, which Claude Code ignores outside user settings, but shows intent");
  if (isObject(json.sandbox) && json.sandbox.enabled === false) add("G09", "info", "sandbox", "turns the Bash sandbox off");
  if (typeof json.agent === "string" && json.agent) add("G04", "warn", `"agent"`, `runs the whole session as the agent ${code(json.agent, 40)}, with that agent's prompt, tools and model`);
  if (typeof json.model === "string" && json.model) add("G04", WEAK_MODEL.test(json.model) ? "warn" : "info", `"model"`, `sets the session's model to ${code(json.model, 40)}`);
  if (!findings.some((f) => f.rule === "G12")) findings.push(...secretFindings(text));
  return findings;
}

function mcpFindings(text: string): Finding[] {
  let json: unknown;
  try {
    json = parseJsonc(text);
  } catch {
    return [{ rule: "G03", severity: "info", line: 1, message: "isn't valid JSON, so guard couldn't read its servers" }];
  }
  const servers = isObject(json) && isObject(json.mcpServers) ? json.mcpServers : {};
  const findings: Finding[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!isObject(server)) continue;
    const line = lineOf(text, `"${name}"`);
    const command = commandText(server);
    if (command) {
      findings.push({ rule: "G03", severity: "info", line, message: `starts the MCP server ${code(name, 40)}: ${code(command)}, which claude -p and SDK sessions connect without asking` });
      for (const hit of commandHits(command, "command")) findings.push({ rule: hit.rule, severity: hit.severity, line, message: hit.message });
    } else if (typeof server.url === "string") {
      findings.push({ rule: "G03", severity: "info", line, message: `connects the MCP server ${code(name, 40)} to ${hostOf(server.url)}` });
    }
    const helper = server.headersHelper;
    if (typeof helper === "string" && helper) findings.push({ rule: "G02", severity: "warn", line: lineOf(text, escaped(helper)), message: `runs ${code(helper)} to make the headers for ${code(name, 40)} (headersHelper)` });
    for (const value of [server.url, ...Object.values(isObject(server.env) ? server.env : {}), ...Object.values(isObject(server.headers) ? server.headers : {}), ...(Array.isArray(server.args) ? server.args : [])]) {
      const secret = typeof value === "string" ? secretIn(value) : null;
      if (secret) {
        findings.push({ rule: "G12", severity: "warn", line, message: `holds what looks like ${secret} for ${code(name, 40)}, in plain text (not shown here)` });
        break;
      }
    }
  }
  if (!findings.some((f) => f.rule === "G12")) findings.push(...secretFindings(text));
  return findings;
}

function otherAgentFindings(text: string, file: string): Finding[] {
  const rel = file.toLowerCase();
  let json: unknown;
  try {
    json = parseJsonc(text);
  } catch {
    return [];
  }
  if (!isObject(json)) return [];
  const findings: Finding[] = [];
  if (rel === ".vscode/tasks.json" && Array.isArray(json.tasks)) {
    for (const task of json.tasks) {
      if (!isObject(task) || !isObject(task.runOptions) || task.runOptions.runOn !== "folderOpen") continue;
      const command = commandText(task) || String(task.label ?? "a task");
      findings.push({ rule: "G11", severity: "warn", line: lineOf(text, "folderOpen"), message: `has VS Code run ${code(command)} when the folder opens, once automatic tasks are allowed` });
    }
  }
  if (rel === ".devcontainer/devcontainer.json") {
    const initialize = json.initializeCommand;
    const shownCommand = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : isObject(v) ? Object.values(v).map(String).join("; ") : "");
    if (initialize) findings.push({ rule: "G11", severity: "warn", line: lineOf(text, "initializeCommand"), message: `runs ${code(shownCommand(initialize))} on your machine, outside the container, when the dev container opens (initializeCommand)` });
    for (const key of ["onCreateCommand", "postCreateCommand", "postStartCommand", "postAttachCommand"]) {
      if (json[key]) findings.push({ rule: "G11", severity: "info", line: lineOf(text, key), message: `runs ${code(shownCommand(json[key]))} inside the dev container (${key})` });
    }
  }
  if ((rel === ".cursor/hooks.json" || rel === ".gemini/settings.json") && isObject(json.hooks)) {
    const tool = rel.startsWith(".cursor") ? "Cursor" : "Gemini CLI";
    const commands = JSON.stringify(json.hooks).match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/g) ?? [];
    for (const raw of commands.slice(0, 5)) {
      const command = JSON.parse(raw.replace(/^"command"\s*:\s*/, ""));
      findings.push({ rule: "G11", severity: "warn", line: lineOf(text, command), message: `has ${tool} run ${code(command)} (a hook)` });
    }
  }
  if (rel === ".gemini/settings.json" && isObject(json.mcpServers)) {
    for (const [name, server] of Object.entries(json.mcpServers)) {
      if (isObject(server) && commandText(server)) findings.push({ rule: "G11", severity: "info", line: lineOf(text, `"${name}"`), message: `has Gemini CLI start the MCP server ${code(name, 40)}: ${code(commandText(server))}` });
    }
  }
  return findings;
}

// The files in the repository that hook and helper commands run, by the paths written in them: a hook that
// runs node .claude/setup.mjs changes what it does when setup.mjs changes, with the settings untouched.
function scriptsRun(root: string, commands: string[]): string[] {
  const found = new Set<string>();
  for (const command of commands) {
    const relative = command.replace(/["']?\$\{?(CLAUDE_PROJECT_DIR|PWD)\}?["']?\//g, "./");
    for (const token of relative.split(/[\s"'`;&|()<>]+/)) {
      const cleaned = token.replace(/^\.\//, "");
      if (!cleaned || cleaned.startsWith("-") || cleaned.includes("$") || !/[/.]/.test(cleaned) || /^[a-z]+:\/\//i.test(cleaned)) continue;
      const abs = path.resolve(root, cleaned);
      const rel = posix(path.relative(root, abs));
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      try {
        if (fs.statSync(abs).isFile() && fs.statSync(abs).size <= MAX_BYTES) found.add(rel);
      } catch {
        // Not a file in the repository: a program on the PATH or an argument.
      }
    }
  }
  return [...found];
}

// The files a CLAUDE.md pulls in with @path, which Claude Code reads as instructions too, up to five deep.
function imports(text: string): string[] {
  const out: string[] = [];
  const withoutCode = text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
  for (const m of withoutCode.matchAll(/(?:^|\s)@((?:\.{0,2}\/)?[\w.-][\w./-]*)/gm)) {
    if (/\.\w+$/.test(m[1]) && !m[1].includes("@")) out.push(m[1]);
  }
  return out;
}

export function lint(text: string, kind: Kind, rel: string): Finding[] {
  const findings = kind === "hook-script" ? [] : hiddenCharacters(text);
  if (TEXT.has(kind)) findings.push(...textFindings(text, kind), ...secretFindings(text));
  else if (kind === "docs") findings.push(...docsFindings(text));
  else if (kind === "settings") findings.push(...settingsFindings(text, rel));
  else if (kind === "mcp") findings.push(...mcpFindings(text));
  else if (kind === "other-agent") findings.push(...otherAgentFindings(text, rel), ...secretFindings(text));
  else if (kind === "hook-script") {
    for (const hit of commandHits(text, "command")) findings.push({ rule: hit.rule, severity: hit.severity, line: lineAt(text, hit.index), message: hit.message });
  }
  // Most severe first, then by line; one finding per rule and line.
  const seen = new Set<string>();
  return findings
    .sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === "warn" ? -1 : 1))
    .filter((f) => {
      const key = `${f.rule}:${f.line}:${f.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// ---- State: what guard saw last time, and the ledger

export function guardHome(): string {
  const custom = process.env.OVERSEER_HOME?.trim();
  return custom ? path.resolve(custom.replace(/^~(?=$|[\\/])/, os.homedir())) : path.join(os.homedir(), ".overseer");
}

type FileState = { kind: Kind; sha256: string; size: number; mtimeMs: number; findings: Finding[]; alerted?: boolean };
export type RepoState = { v: 1; rules: number; root: string; scannedAt: string; head: string | null; files: Record<string, FileState> };

const stateFile = (root: string) => path.join(guardHome(), "trust", "repos", `${sha256(root).slice(0, 24)}.json`);
const ledgerFile = () => path.join(guardHome(), "trust", "ledger.jsonl");

export function loadState(root: string): RepoState | null {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    return state?.v === 1 && state.root === root && isObject(state.files) ? state : null;
  } catch {
    return null;
  }
}

function writePrivate(file: string, data: string, append = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (append) return fs.appendFileSync(file, data, { mode: 0o600 });
  // Written whole and renamed, so two sessions starting together can't leave half a file.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}

// Saves what this scan saw, and adds a ledger line for each file that's new, changed or gone. alerted marks the
// files whose warnings the user has been shown, so each version of a file is pointed out once.
export function saveState(scan: Scan, previous: RepoState | null, alerted: Set<string>, by: string, version: string) {
  const files: Record<string, FileState> = {};
  const stats = new Map(scan.files.map((e) => [e.path, statOf(path.join(scan.root, e.path))]));
  for (const e of scan.files) {
    const before = previous?.files[e.path];
    const stat = stats.get(e.path);
    files[e.path] = {
      kind: e.kind,
      sha256: e.sha256,
      size: e.size,
      mtimeMs: stat?.mtimeMs ?? 0,
      findings: e.findings,
      alerted: alerted.has(e.path) || (before?.sha256 === e.sha256 && before.alerted) || undefined,
    };
  }
  // A scan of changed files only keeps what it didn't look at.
  if (scan.since && previous) for (const [rel, file] of Object.entries(previous.files)) if (!(rel in files) && !scan.removed.includes(rel)) files[rel] = file;
  const state: RepoState = { v: 1, rules: RULES_VERSION, root: scan.root, scannedAt: new Date().toISOString(), head: scan.head, files };
  writePrivate(stateFile(scan.root), JSON.stringify(state));
  const at = state.scannedAt;
  const lines = [
    ...scan.files
      .filter((e) => e.status !== "seen")
      .map((e) => ({ v: 1, at, root: scan.root, head: scan.head, path: e.path, kind: e.kind, sha256: e.sha256, event: e.status === "changed" ? "changed" : "seen", findings: e.findings.map(({ rule, severity, line }) => ({ rule, severity, line })), by, overseer: version })),
    ...scan.removed.map((rel) => ({ v: 1, at, root: scan.root, head: scan.head, path: rel, event: "removed", by, overseer: version })),
  ];
  if (lines.length) writePrivate(ledgerFile(), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), true);
}

const statOf = (file: string) => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};

// ---- Scanning

export type ScanOptions = { since?: string; previous?: RepoState | null };

export class GuardError extends Error {}

// Reads one file of the inventory: its hash and findings, reusing the last scan's when its size and time are
// the same and the rules haven't changed.
function entryOf(root: string, rel: string, kind: Kind, previous: RepoState | null): Omit<Entry, "status"> | null {
  const abs = path.join(root, rel);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(abs);
  } catch {
    return null;
  }
  const findings: Finding[] = [];
  if (lstat.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.realpathSync(abs);
    } catch {
      return null;
    }
    const inside = posix(path.relative(fs.realpathSync(root), target));
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      // Only the link is read: the file it points to may be private.
      return { path: rel, kind, sha256: sha256(`link:${target}`), size: 0, findings: [{ rule: "G13", severity: "warn", line: 1, message: `is a link to ${shown(target.replace(os.homedir(), "~"), 80)}, outside the repository, which Claude Code would read as this file` }] };
    }
  }
  const stat = statOf(abs);
  if (!stat?.isFile()) return null;
  const cached = previous?.rules === RULES_VERSION ? previous.files[rel] : undefined;
  if (cached && cached.kind === kind && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return { path: rel, kind, sha256: cached.sha256, size: stat.size, findings: cached.findings };
  if (stat.size > MAX_BYTES) {
    return { path: rel, kind, sha256: sha256(`size:${stat.size}:${stat.mtimeMs}`), size: stat.size, findings: [{ rule: "G01", severity: "info", line: 1, message: `is over ${MAX_BYTES >> 20} MB, so guard didn't read it` }] };
  }
  const data = fs.readFileSync(abs);
  findings.push(...lint(data.toString("utf8"), kind, rel));
  return { path: rel, kind, sha256: sha256(data), size: stat.size, findings };
}

// Every file Claude Code acts on in the folder, with what the rules say about each, and its status against the
// last scan. root is the folder Claude Code runs in. With since, only files changed between that git ref and HEAD.
export function scanRepo(root: string, options: ScanOptions = {}): Scan {
  const real = fs.realpathSync(root);
  const previous = options.previous === undefined ? loadState(real) : options.previous;
  const kinds = new Map<string, Kind>();
  for (const rel of listFiles(real)) kinds.set(rel, kindOf(rel)!);

  const entries: Omit<Entry, "status">[] = [];
  const add = (rel: string, kind: Kind) => {
    const entry = entryOf(real, rel, kind, previous);
    if (entry) entries.push(entry);
    return entry;
  };
  for (const [rel, kind] of kinds) add(rel, kind);

  // The scripts hooks run, and the files CLAUDE.md files import, are part of what steers Claude Code too.
  const commands: string[] = [];
  for (const e of entries) {
    if (e.kind !== "settings" && e.kind !== "mcp") continue;
    try {
      const json = parseJsonc(fs.readFileSync(path.join(real, e.path), "utf8"));
      if (isObject(json)) {
        if (e.kind === "settings") commands.push(...settingsCommands("", json).map((c) => c.command));
        if (isObject(json.mcpServers)) for (const server of Object.values(json.mcpServers)) if (isObject(server)) commands.push(commandText(server));
      }
    } catch {
      // Already reported by its own findings.
    }
  }
  for (const rel of scriptsRun(real, commands)) {
    if (kinds.has(rel)) continue;
    kinds.set(rel, "hook-script");
    add(rel, "hook-script");
  }
  const queue = entries.filter((e) => e.kind === "instructions").map((e) => ({ rel: e.path, depth: 0 }));
  while (queue.length) {
    const { rel, depth } = queue.shift()!;
    if (depth >= 5) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(real, rel), "utf8");
    } catch {
      continue;
    }
    for (const target of imports(text)) {
      const imported = posix(path.relative(real, path.resolve(real, path.posix.dirname(rel), target)));
      if (imported.startsWith("..") || path.isAbsolute(imported)) continue;
      // A doc that a CLAUDE.md imports is instructions, and gets their rules.
      if (kinds.get(imported) === "docs") {
        const at = entries.findIndex((e) => e.path === imported);
        if (at >= 0) entries.splice(at, 1);
      } else if (kinds.has(imported)) continue;
      kinds.set(imported, "instructions");
      if (add(imported, "instructions")) queue.push({ rel: imported, depth: depth + 1 });
    }
  }

  let files = entries.map((e): Entry => {
    const before = previous?.files[e.path];
    const status: Status = !previous ? "first" : !before ? "new" : before.sha256 !== e.sha256 ? "changed" : "seen";
    return { ...e, status };
  });
  let removed = previous ? Object.keys(previous.files).filter((rel) => !kinds.has(rel)) : [];
  if (options.since) {
    const changed = changedSince(real, options.since);
    files = files.filter((e) => changed.has(e.path));
    removed = removed.filter((rel) => changed.has(rel));
  }
  return { root: real, head: headOf(real), first: !previous, files: files.sort((a, b) => a.path.localeCompare(b.path)), removed, since: options.since };
}

// The paths, relative to root, that differ between ref and HEAD.
export function changedSince(root: string, ref: string): Set<string> {
  if (!isGitRepo(root)) throw new GuardError(`--since needs a git repository, and ${root} isn't in one.`);
  if (!/^[\w./@{}^~-]+$/.test(ref) || ref.startsWith("-") || git(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) === null) {
    throw new GuardError(`${ref} isn't a commit this repository has. In a shallow clone, fetch it first, such as with git fetch --depth=1 origin ${ref}.`);
  }
  const out = git(root, ["diff", "--name-only", "-z", "--no-renames", "--relative", ref, "HEAD"]);
  if (out === null) throw new GuardError(`git couldn't compare ${ref} with HEAD.`);
  return new Set(out.split("\0").filter(Boolean));
}

// ---- What to tell people

export const warnings = (e: Entry) => e.findings.filter((f) => f.severity === "warn");

const KIND_LABEL: Record<Kind, string> = {
  instructions: "instructions",
  agent: "agent",
  skill: "skill",
  command: "command",
  "output-style": "output style",
  settings: "settings",
  mcp: "MCP servers",
  "hook-script": "run by a hook or MCP server",
  "other-agent": "another tool's config",
  docs: "docs",
};
export const kindLabel = (e: Entry) => (e.kind === "settings" && e.path.toLowerCase().endsWith("settings.local.json") ? "local settings" : KIND_LABEL[e.kind]);

// What needs pointing out at session start: files with warnings not shown before in this version, and, after
// the first scan, new or changed files that run code: a script a hook runs, or settings and MCP servers that
// now do something a rule notes.
export function toPointOut(scan: Scan, previous: RepoState | null): Entry[] {
  return scan.files.filter((e) => {
    const before = previous?.files[e.path];
    if (warnings(e).length) return !(before?.sha256 === e.sha256 && before.alerted);
    const moved = !scan.first && (e.status === "new" || e.status === "changed");
    return moved && (e.kind === "hook-script" || (RUNS.has(e.kind) && e.findings.length > 0));
  });
}

// One line per file: its path and what it does, from its first warning, putting first what's new since the
// version guard saw before, when it saw one.
export function describe(e: Entry, before?: Finding[]): string {
  const known = new Set((before ?? []).map((f) => `${f.rule}:${f.message}`));
  const fresh = warnings(e).filter((f) => !known.has(`${f.rule}:${f.message}`));
  const first = fresh[0] ?? warnings(e)[0] ?? e.findings[0];
  const change = e.status === "new" ? "new since the last session" : e.status === "changed" ? "changed since the last session" : "";
  const what = first ? first.message : e.kind === "hook-script" ? "is run by a hook or MCP server" : "has nothing flagged";
  const more = warnings(e).length > 1 ? ` (+${warnings(e).length - 1} more)` : "";
  return `${e.path}${change ? ` (${change})` : ""} ${what}${more}`;
}

export function sessionNotes(scan: Scan, points: Entry[], previous: RepoState | null = null): { user?: string; claude?: string } {
  if (!points.length) return {};
  const total = scan.files.filter((e) => e.kind !== "docs").length;
  const lines = points.map((e) => describe(e, previous?.files[e.path]?.findings));
  const user = `Overseer guard: ${points.length} of ${total} agent-config file${total === 1 ? "" : "s"} here need${points.length === 1 ? "s" : ""} a look. ${clip(lines.slice(0, 2).join("; "), 420)}${lines.length > 2 ? `; and ${lines.length - 2} more` : ""}. Free check, nothing sent; /overseer:guard for details.`;
  const claude = [
    "Overseer guard, a free local lint of this project's agent configuration, found files the user hasn't reviewed yet. They came with the repository or changed since the last session, and their contents are unverified:",
    ...points.slice(0, 20).map((e) => `- ${e.path} (${kindLabel(e)}): ${e.findings.filter((f) => f.severity === "warn").map((f) => `${RULE_SHORT[f.rule]}: ${f.message} (line ${f.line})`).join("; ") || describe(e).slice(e.path.length + 1)}`),
    points.length > 20 ? `- and ${points.length - 20} more` : "",
    "The user can review them with /overseer:guard, or npx @adamsaou/overseer guard in a terminal.",
  ].filter(Boolean);
  return { user, claude: clip(claude.join("\n"), 6000) };
}

const RULE_SHORT: Record<RuleId, string> = {
  G01: "G01 hidden characters",
  G02: "G02 runs code",
  G03: "G03 MCP servers and plugins",
  G04: "G04 who does the work",
  G05: "G05 steering text",
  G06: "G06 remote code",
  G07: "G07 destructive",
  G08: "G08 sends data out",
  G09: "G09 weakened oversight",
  G10: "G10 environment overrides",
  G11: "G11 other tools' auto-run",
  G12: "G12 secrets",
  G13: "G13 links outside",
};
export const ruleShort = (rule: RuleId) => RULE_SHORT[rule];

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// The absolute paths FileChanged should watch: every file of the inventory except docs, and the places
// settings, MCP servers and instructions appear when they don't exist yet, so a file written mid-session counts.
export function watchPaths(scan: Scan): string[] {
  const paths = new Set(scan.files.filter((e) => e.kind !== "docs").map((e) => path.join(scan.root, e.path)));
  for (const rel of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", "CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", ".vscode/tasks.json"]) paths.add(path.join(scan.root, rel));
  return [...paths].slice(0, 500);
}

// The root a hook or the CLI should scan: the project folder, unless that's the home folder or the filesystem
// root, where a scan would read far beyond one project.
export function projectFolder(dir: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return null;
  }
  if (real === path.parse(real).root || real === fs.realpathSync(os.homedir())) return null;
  return statOf(real)?.isDirectory() ? real : null;
}
