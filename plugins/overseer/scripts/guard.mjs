// Built from lib/guard-hook.ts and lib/guard.ts by scripts/build-hooks.ts; edit those, then npm run build:hooks.

// lib/guard-hook.ts
import fs2 from "node:fs";
import path2 from "node:path";

// lib/guard.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var RULES_VERSION = 1;
var MAX_BYTES = 1 << 20;
var MAX_FILES = 2e3;
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "vendor", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache"]);
var INSTRUCTION_NAMES = /* @__PURE__ */ new Set(["claude.md", "claude.local.md", "agents.md", "gemini.md", ".cursorrules", ".windsurfrules", ".clinerules"]);
var RUNS = /* @__PURE__ */ new Set(["settings", "mcp", "hook-script", "other-agent"]);
var TEXT = /* @__PURE__ */ new Set(["instructions", "agent", "skill", "command", "output-style"]);
var PATHSPECS = [
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
  "docs/*.md"
].map((spec) => `:(glob,icase)${spec}`);
function kindOf(rel) {
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
  if (ext === ".md" && (dirs.length === 0 || dirs.length === 1 && dirs[0] === "docs")) return "docs";
  return null;
}
var posix = (p) => p.split(path.sep).join("/");
var sha256 = (data) => createHash("sha256").update(data).digest("hex");
function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20, timeout: 1e4 });
  } catch {
    return null;
  }
}
var isGitRepo = (root) => git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
var headOf = (root) => git(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
function listFiles(root) {
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...PATHSPECS]);
  const found = /* @__PURE__ */ new Set();
  if (listed !== null) {
    for (const rel of listed.split("\0")) if (rel && kindOf(rel)) found.add(rel);
    for (const rel of [".claude/settings.local.json", "CLAUDE.local.md", ".mcp.json"]) if (fs.existsSync(path.join(root, rel))) found.add(rel);
  } else {
    walk(root, "", 0, found, { dirs: 0 });
  }
  return [...found].sort().slice(0, MAX_FILES);
}
function walk(root, rel, depth, found, budget) {
  if (depth > 8 || found.size >= MAX_FILES || ++budget.dirs > 5e3) return;
  let entries;
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
var lineAt = (text, index) => {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
};
var lineOf = (text, needle) => {
  const index = text.indexOf(needle);
  return index < 0 ? 1 : lineAt(text, index);
};
function shown(text, n = 100) {
  const line = text.replace(HIDDEN_ANY, (ch) => `\\u{${ch.codePointAt(0).toString(16).toUpperCase()}}`).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}\u2026` : line;
}
var code = (text, n = 90) => `\`${shown(text, n).replace(/`/g, "'")}\``;
function negated(text, index) {
  const start = Math.max(text.lastIndexOf("\n", index - 1), text.lastIndexOf(". ", index - 1), index - 120, 0);
  return /\b(never|don't|do not|must not|mustn't|should not|shouldn't|cannot|can't|avoid|no longer|prohibited|forbidden|not allowed|refuse|instead of|rather than|blocks?|blocked|denies|deny|denied|dangerous|careful|warning)\b/i.test(
    text.slice(start, index)
  );
}
function firstMatch(pattern, text, skipQuoted = false) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let m = global.exec(text); m; m = global.exec(text)) {
    if (!negated(text, m.index) && !(skipQuoted && quoted(text, m.index))) return m;
    if (m[0].length === 0) global.lastIndex++;
  }
  return null;
}
function quoted(text, index) {
  const before = text.slice(Math.max(text.lastIndexOf("\n", index - 1) + 1, index - 200), index);
  return /["“'‘]\s*$/.test(before) || (before.match(/"/g)?.length ?? 0) % 2 === 1 && !/`/.test(before);
}
var HIDDEN_ANY = /[­ᅟᅠ᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
var PICTURE = new RegExp("\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\p{Regional_Indicator}|[\u20E3\\u{1F3FB}-\\u{1F3FF}]", "u");
var EMOJI_BASE = /^[#*0-9©®‼⁉™ℹ←-⇿⌀-➿⤴⤵⬀-⯿〰〽㊗㊙]$/u;
var JOINING = (ch) => /[\p{L}\p{M}]/u.test(ch) && !new RegExp("\\p{Script=Latin}|\\p{Script=Common}", "u").test(ch);
function legitimate(text, index, ch, prev, next) {
  const cp = ch.codePointAt(0);
  if (cp === 65279) return index === 0;
  if (cp >= 917536 && cp <= 917631) return inFlag(text, index);
  if (cp >= 65024 && cp <= 65039) return PICTURE.test(prev) || EMOJI_BASE.test(prev);
  if (cp === 8205) return PICTURE.test(prev) && PICTURE.test(next) || JOINING(prev) && JOINING(next);
  if (cp === 8204) return JOINING(prev) && JOINING(next);
  if (cp === 173) return new RegExp("\\p{L}", "u").test(prev) && new RegExp("\\p{L}", "u").test(next);
  return false;
}
function inFlag(text, index) {
  let i = index;
  let tags = 0;
  while (i >= 2 && tags <= 8) {
    const cp = text.codePointAt(i - 2);
    if (cp === 127988) return true;
    if (cp < 917536 || cp > 917631) return false;
    i -= 2;
    tags++;
  }
  return false;
}
function hiddenCharacters(text) {
  const chars = [...text.matchAll(HIDDEN_ANY)].filter((m) => {
    const i = m.index;
    const prev = [...text.slice(Math.max(0, i - 2), i)].pop() ?? "";
    const next = [...text.slice(i + m[0].length, i + m[0].length + 2)][0] ?? "";
    return !legitimate(text, i, m[0], prev, next);
  });
  if (!chars.length) return [];
  const points = chars.map((m) => m[0].codePointAt(0));
  const tags = points.filter((cp) => cp >= 917536 && cp <= 917630);
  const controls = points.some((cp) => cp >= 8234 && cp <= 8238 || cp >= 8294 && cp <= 8297 || cp >= 917504);
  const message = `hides ${chars.length} character${chars.length === 1 ? "" : "s"} a reader can't see (zero-width, bidirectional or tag)${tags.length >= 4 ? `, whose tag characters spell "${shown(String.fromCharCode(...tags.map((cp) => cp - 917504)), 80)}"` : ""}`;
  return [{ rule: "G01", severity: controls || chars.length >= 3 ? "warn" : "info", line: lineAt(text, chars[0].index), message }];
}
var KNOWN_INSTALLERS = /https?:\/\/(astral\.sh|bun\.sh|deno\.land|sh\.rustup\.rs|get\.pnpm\.io|raw\.githubusercontent\.com\/nvm-sh|fnm\.vercel\.app|get\.volta\.sh|install\.python-poetry\.org|pyenv\.run|claude\.ai\/install|get\.docker\.com|cli\.github\.com|brew\.sh|raw\.githubusercontent\.com\/Homebrew)\//i;
var REMOTE = [
  /\b(curl|wget|fetch)\b[^|\n;]{0,300}\|\s*(sudo\s+)?(-?\w+=\S+\s+)*(ba|z|k|da|fi)?sh\b/i,
  /\b(curl|wget)\b[^|\n;]{0,300}\|\s*(sudo\s+)?(python3?|node|perl|ruby|php|deno|bun)\b/i,
  /\b(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/i,
  /\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/i,
  /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]{0,300}\|\s*(iex|Invoke-Expression)\b/i,
  /\b(iex|Invoke-Expression)\b[^\n]{0,80}\b(DownloadString|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/i,
  /\bbase64\s+(-d|--decode|-D)\b[^|\n]{0,200}\|\s*(ba|z)?sh\b/i,
  /\becho\s+["']?[A-Za-z0-9+/=]{60,20000}["']?\s*\|\s*base64\s+(-d|--decode|-D)\b/i
];
var DESTRUCTIVE = [
  /\brm\s+(-[a-zA-Z]{0,8}r[a-zA-Z]{0,8}f[a-zA-Z]{0,8}|-[a-zA-Z]{0,8}f[a-zA-Z]{0,8}r[a-zA-Z]{0,8}|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\s+(--no-preserve-root\s+)?["']?(\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\/\*|~\/\*|\$HOME\/\*)["']?(?=\s|$|[;&|`)])/,
  // The Amazon Q extension's planted prompt: "clean a system to a near-factory state and delete file-system and cloud resources".
  /\b(near[- ]factory|factory[- ](state|reset|settings|defaults))\b/i,
  /\b(delete|wipe|erase|destroy|purge|remove)\s+(all\s+|every\s+|the\s+entire\s+|the\s+whole\s+)?(of\s+)?(the\s+|their\s+|your\s+)?(file[- ]?systems?|hard (disks?|drives?)|home (folders?|director(y|ies))|cloud resources|(all|every)\s+(repositor(y|ies)|databases?|buckets?|instances?|users?|backups?|resources))\b/i,
  /\bmkfs(\.\w+)?\s+\/dev\//,
  /\bdd\s+[^\n]*\bof=\/dev\/(sd|nvme|hd|disk|xvd)/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/
];
var SECRET_FILES = String.raw`(\.env\b|\.ssh\/|id_rsa|id_ed25519|id_ecdsa|\.aws\/credentials|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.kube\/config|\.docker\/config\.json|\.config\/gh\/hosts|Keychains?\/|\.gnupg\/)`;
var SENDERS = String.raw`(curl|wget|nc|ncat|socat|scp|rsync|httpie|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)`;
var SEND_FILE = [
  // A command that sends a secret file somewhere, or reads one into a command that does.
  new RegExp(String.raw`\b${SENDERS}\b[^\n]{0,200}${SECRET_FILES}`),
  new RegExp(String.raw`${SECRET_FILES}[^\n]{0,80}\|\s*${SENDERS}\b`)
];
var SEND_WORDS = [
  [/\b(send|post|upload|exfiltrate|forward|transmit|leak|share|copy|paste|report|push|sync)\b/i, 0],
  [/\b(secrets?|tokens?|credentials?|api[- ]?keys?|passwords?|private keys?|ssh keys?|environment variables|env vars|cookies|session (ids?|tokens?)|screenshots?|keychain|wallets?|seed phrases?)\b|\.env\b/i, 80],
  [/\b(to|into|at|via|on|with)\b/i, 80],
  [/https?:\/\/|\bwebhook|\bgists?\b|pastebin|\bpaste\.|discord|telegram|ngrok|requestbin|pipedream|\ban? (external|remote|third[- ]party) (server|endpoint|url|service|host)\b|\bpublic (repo|repository|gist|bucket)\b/i, 40]
];
var MAKE_PUBLIC = [
  [/\b(create|make|open|publish|upload|post|push|put)\b/i, 0],
  [/\bpublic\b/i, 60],
  [/\b(gists?|repo|repos|repository|repositories|pastes?|buckets?|links?|releases?)\b/i, 20]
];
var PRIVATE_DATA = /\b(screenshots?|screen ?shots?|screen recordings?|transcripts?|sessions?|conversations?|logs?|dumps?|traces?|secrets?|credentials?|tokens?|keys?|\.env|private)\b/i;
function chain(text, steps) {
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
function commandHits(text, where) {
  const hits = [];
  const says = (does, told) => where === "text" ? told : does;
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
function contextOf(text, index) {
  const start = Math.max(text.lastIndexOf("\n", index - 1) + 1, index - 40);
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? void 0 : end);
}
var SECRETS = [
  [/sk-ant-[A-Za-z0-9_-]{20}/, "an Anthropic API key"],
  [/\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32}/, "an OpenAI-style API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36}|\bgithub_pat_[A-Za-z0-9_]{60}/, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10}/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/, "a private key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "an npm token"],
  [/\bglpat-[A-Za-z0-9_-]{20}/, "a GitLab token"],
  [/\beyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10}/, "a JSON web token"]
];
function secretIn(value) {
  for (const [pattern, what] of SECRETS) if (pattern.test(value)) return what;
  return null;
}
function secretFindings(text) {
  for (const [pattern, what] of SECRETS) {
    const m = pattern.exec(text);
    if (m) return [{ rule: "G12", severity: "warn", line: lineAt(text, m.index), message: `holds what looks like ${what}, in plain text (not shown here)` }];
  }
  return [];
}
function frontmatter(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return null;
  const keys = /* @__PURE__ */ new Map();
  let current = null;
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
var unquote = (value) => value.replace(/^(["'])([\s\S]*)\1$/, "$2");
function listOf(entry) {
  if (!entry) return [];
  const items = [];
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
var blockCommands = (block) => block.map((line) => /^\s*-?\s*command\s*:\s*(.+)$/.exec(line)?.[1]).filter((c) => Boolean(c)).map((c) => unquote(c.trim()));
var REVIEWER = /\b(review(s|er|ers|ing)?|audit(s|or|ors|ing)?|security|verif(y|ies|ier|ication)|approv(e|es|al|er)|gatekeep(er|ing)?|inspect(or|ion)?|qa)\b/i;
var NARROWED = /\b(only (review|check|look at|read|scan|inspect|audit|consider)|limit (your |the |its )?(review|scope|checks?) to|ignore|skip|exclude|don't (review|check|read|open|look at)|do not (review|check|read|open|look at))\b[^.\n]{0,40}?(\b(tests?|specs?|src|docs?|scripts?|ci|workflows?|hooks?|config)\b|\.github\b|\.claude\b|\b(?!node_modules\/|dist\/|build\/|vendor\/|coverage\/|out\/|target\/)[\w.-]{1,80}\/)/i;
var WEAK_MODEL = /^(haiku|claude-haiku[\w.-]*|claude-3[\w.-]*|claude-instant[\w.-]*)$/i;
var BROAD_TOOLS = /^(Bash|PowerShell|WebFetch)(\(\s*(\*{1,2}|:\*)?\s*\))?$|^(Bash|PowerShell)\(\s*(curl|wget|sh|bash|zsh|fish|python3?|node|deno|bun|npx|bunx|pnpx|uvx|pipx|eval|sudo|env|xargs|perl|ruby|php)(\s*:\s*\*|\s+\*{1,2})?\s*\)$/;
function textFindings(text, kind) {
  const findings = [];
  const front = kind === "agent" || kind === "skill" || kind === "command" ? frontmatter(text) : null;
  const body = front ? text.slice(front.end) : text;
  const offset = front ? lineAt(text, front.end) - 1 : 0;
  const add = (hit) => findings.push({ rule: hit.rule, severity: hit.severity, line: offset + lineAt(body, hit.index), message: hit.message });
  if (front) {
    const hooks = front.keys.get("hooks");
    for (const command of blockCommands(hooks?.block ?? [])) {
      findings.push({ rule: "G02", severity: "warn", line: hooks.line, message: `runs ${code(command)} while this ${kind} is in use (a hook in its frontmatter)` });
    }
    const servers = front.keys.get("mcpservers");
    for (const command of blockCommands(servers?.block ?? [])) {
      findings.push({ rule: "G03", severity: "info", line: servers.line, message: `starts an MCP server for this ${kind}: ${code(command)}` });
    }
    const allowed = front.keys.get("allowed-tools");
    const broad = listOf(allowed).filter((tool) => BROAD_TOOLS.test(tool));
    if (broad.length) {
      findings.push({
        rule: "G09",
        severity: "warn",
        line: allowed.line,
        message: `pre-approves ${broad.map((t) => code(t)).join(", ")} whenever this ${kind} runs, with no prompt, and workspace trust doesn't gate that`
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
        const what = [weak && `pins the model ${model.value}`, blind && `can only use ${tools.join(", ")}`, narrowed && `narrows its review: ${code(narrowed[0], 70)}`].filter(Boolean);
        findings.push({ rule: "G04", severity: "warn", line: weak ? model.line : offset + lineAt(body, narrowed?.index ?? 0), message: `is a reviewer this repository defines, and ${what.join(", and ")}` });
      } else if (weak) {
        findings.push({ rule: "G04", severity: "info", line: model.line, message: `pins the model ${model.value}` });
      }
    }
  }
  if (kind === "skill" || kind === "command") {
    for (const m of body.matchAll(/!`([^`\n]+)`|^```!\s*\n([\s\S]*?)^```/gm)) {
      const command = m[1] ?? m[2] ?? "";
      const hits = commandHits(command, "command");
      if (hits.length) hits.forEach((hit) => add({ ...hit, index: m.index }));
      else add({ rule: "G02", severity: "info", index: m.index, message: `runs ${code(command)} when invoked (inline shell)` });
    }
  }
  for (const hit of commandHits(body, "text")) add(hit);
  const conceal = /\b(do not|don't|never)\s+(tell|inform|notify|alert|warn|mention (it |this |that |these )?to|reveal (it |this |that |these )?to|disclose (it |this |that |these )?to)\s+(it\s+|this\s+|that\s+)?(to\s+)?(the\s+)?(user|human|developer|maintainer|operator|reviewer|owner|person)s?\b(?!\s+(to|how to)\b)/i.exec(body);
  if (conceal) add({ rule: "G09", severity: "warn", index: conceal.index, message: `tells the agent to keep something from the user: ${code(contextOf(body, conceal.index))}` });
  const unmonitor = firstMatch(/\b(disable|turn off|switch off|remove|delete|bypass|circumvent|silence|suppress|mute|tamper with|uninstall)\s+(the\s+|any\s+|all\s+|its\s+|their\s+)?(monitor(ing|s)?|alerting|audit(ing)?\s+(logs?|trails?)|guardrails?|safety (checks?|filters?|classifiers?)|security (checks?|scans?|scanning|tools?)|overseer|oversight)\b/i, body);
  if (unmonitor) add({ rule: "G09", severity: "warn", index: unmonitor.index, message: `tells the agent to switch off oversight: ${code(contextOf(body, unmonitor.index))}` });
  const verify = firstMatch(/--no-verify\b|\bcore\.hooksPath\s*=?\s*\/dev\/null/, body);
  if (verify) add({ rule: "G09", severity: "info", index: verify.index, message: `skips git hooks: ${code(contextOf(body, verify.index))}` });
  for (const hit of overrides(body, "warn")) add(hit);
  return findings;
}
var OVERRIDE = /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding|other|system|original)\s+(instructions|rules|prompts?|directions|guidelines)\b/i;
function overrides(text, severity) {
  const m = firstMatch(OVERRIDE, text, true);
  return m ? [{ rule: "G05", severity, index: m.index, message: `tries to override the agent's instructions: ${code(contextOf(text, m.index))}` }] : [];
}
var ADDRESSED = [
  /\b(if|when|since|as)\s+you('re|\s+are)\s+(an?\s+)?(AI|LLM|large language model|language model|assistant|agent|coding agent|bot|Claude|Copilot|Cursor|Codex|ChatGPT|GPT|Gemini)\b/i,
  /\b(note|attention|important|instructions?|message|reminder|notice)\s*(to|for)\s+(all\s+|any\s+)?(AI|LLMs?|language models?|assistants?|agents?|coding agents?|bots?|Claude|Copilot|Cursor|Codex|ChatGPT|Gemini)\b/i,
  /\b(AI|LLM|language model|coding)\s+(assistants?|agents?|models?|tools?)\s*[:,-]\s*(you|please|ignore|run|always|never|do|don't|make)\b/i,
  /^\s*(Claude|Copilot|Cursor|Codex|ChatGPT|Gemini|AI|Assistant|Agent)s?\s*[:,-]\s*(you|please|ignore|run|always|never|do|don't|make|before)\b/im
];
function docsFindings(text) {
  const findings = [];
  for (const m of text.matchAll(/<!--([\s\S]{0,4000}?)-->|^\[\/\/\]: # \(([^)\n]{0,4000})\)|<[a-z]{1,10}[^>]{0,300}style\s*=\s*["'][^"']{0,300}(display\s*:\s*none|font-size\s*:\s*0|visibility\s*:\s*hidden|opacity\s*:\s*0)[^"']{0,300}["'][^>]{0,300}>([\s\S]{0,4000}?)<\/[a-z]{1,10}>/gim)) {
    const hidden = m[1] ?? m[2] ?? m[4] ?? "";
    if (ADDRESSED.some((p) => p.test(hidden)) || OVERRIDE.test(hidden)) {
      findings.push({ rule: "G05", severity: "warn", line: lineAt(text, m.index), message: `hides text from readers that addresses AI agents: ${code(hidden, 110)}` });
      break;
    }
  }
  findings.push(...overrides(text, "info").map((hit) => ({ ...hit, line: lineAt(text, hit.index) })));
  return findings;
}
function parseJsonc(text) {
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
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var escaped = (value) => JSON.stringify(value).slice(1, -1);
var commandText = (h) => [typeof h.command === "string" ? h.command : "", ...Array.isArray(h.args) ? h.args.filter((a) => typeof a === "string") : []].join(" ").trim();
var WHEN = {
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
  Notification: "on notifications"
};
function settingsCommands(text, json) {
  const out = [];
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
    if (typeof json[key] === "string" && json[key]) out.push({ command: json[key], where: `as ${key}`, line: lineOf(text, `"${key}"`) });
  }
  for (const key of ["statusLine", "subagentStatusLine", "fileSuggestion"]) {
    const value = json[key];
    if (isObject(value) && typeof value.command === "string" && value.command) out.push({ command: value.command, where: `to draw the ${key === "fileSuggestion" ? "file suggestions" : "status line"}`, line: lineOf(text, `"${key}"`) });
  }
  return out;
}
var ENDPOINT_VARS = /^(ANTHROPIC_(BASE_URL|AWS_BASE_URL|BEDROCK_BASE_URL|BEDROCK_MANTLE_BASE_URL|VERTEX_BASE_URL|FOUNDRY_BASE_URL)|OTEL_EXPORTER_OTLP(_\w+)?_ENDPOINT|BETA_TRACING_ENDPOINT|HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy)$/;
var TLS_VARS = /^(NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/;
var KEY_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_CUSTOM_HEADERS|OTEL_EXPORTER_OTLP(_\w+)?_HEADERS|AWS_BEARER_TOKEN_BEDROCK)$/;
var EXEC_VARS = /^(NODE_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|ZDOTDIR|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+|GIT_CONFIG_PARAMETERS|PATH|SHELL|CLAUDE_CODE_SHELL|CLAUDE_CODE_SHELL_PREFIX|npm_config_\w+|NPM_CONFIG_\w+)$/;
var MODEL_VARS = /^(CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_AUTO_MODE_MODEL|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_DEFAULT_(HAIKU|SONNET|OPUS|FABLE)_MODEL)$/;
var SAFETY_VARS = /^CLAUDE_CODE_DISABLE_\w*(RM_PROMPT|RM_DENY|SANDBOX|PERMISSION|CLASSIFIER|SAFETY)\w*$/;
var OFF = /^(off|0|false|no)$/i;
function repositoryTurnsGuardOff(root) {
  try {
    const json = parseJsonc(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
    const env = isObject(json) && isObject(json.env) ? json.env : {};
    return ["OVERSEER_GUARD", "OVERSEER_HOOK"].some((name) => typeof env[name] === "string" && OFF.test(env[name].trim()));
  } catch {
    return false;
  }
}
var hostOf = (value) => {
  try {
    return new URL(value).host || value;
  } catch {
    return shown(value, 60);
  }
};
function envFindings(text, env) {
  const findings = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = typeof raw === "string" ? raw : JSON.stringify(raw);
    const line = lineOf(text, `"${name}"`);
    const secret = secretIn(value);
    const add = (rule, message, severity = "warn") => findings.push({ rule, severity, line, message });
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
function settingsFindings(text, rel) {
  let json;
  try {
    json = parseJsonc(text);
  } catch {
    return [{ rule: "G02", severity: "info", line: 1, message: "isn't valid JSON, so Claude Code ignores it and guard couldn't read it" }];
  }
  if (!isObject(json)) return [];
  const findings = [];
  const add = (rule, severity, needle, message) => findings.push({ rule, severity, line: lineOf(text, needle), message });
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
      const source = isObject(value) && isObject(value.source) ? value.source.repo ?? value.source.url ?? value.source.path ?? value.source.source : void 0;
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
function mcpFindings(text) {
  let json;
  try {
    json = parseJsonc(text);
  } catch {
    return [{ rule: "G03", severity: "info", line: 1, message: "isn't valid JSON, so guard couldn't read its servers" }];
  }
  const servers = isObject(json) && isObject(json.mcpServers) ? json.mcpServers : {};
  const findings = [];
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
    for (const value of [server.url, ...Object.values(isObject(server.env) ? server.env : {}), ...Object.values(isObject(server.headers) ? server.headers : {}), ...Array.isArray(server.args) ? server.args : []]) {
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
function otherAgentFindings(text, file) {
  const rel = file.toLowerCase();
  let json;
  try {
    json = parseJsonc(text);
  } catch {
    return [];
  }
  if (!isObject(json)) return [];
  const findings = [];
  if (rel === ".vscode/tasks.json" && Array.isArray(json.tasks)) {
    for (const task of json.tasks) {
      if (!isObject(task) || !isObject(task.runOptions) || task.runOptions.runOn !== "folderOpen") continue;
      const command = commandText(task) || String(task.label ?? "a task");
      findings.push({ rule: "G11", severity: "warn", line: lineOf(text, "folderOpen"), message: `has VS Code run ${code(command)} when the folder opens, once automatic tasks are allowed` });
    }
  }
  if (rel === ".devcontainer/devcontainer.json") {
    const initialize = json.initializeCommand;
    const shownCommand = (v) => typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : isObject(v) ? Object.values(v).map(String).join("; ") : "";
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
function scriptsRun(root, commands) {
  const found = /* @__PURE__ */ new Set();
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
      }
    }
  }
  return [...found];
}
function imports(text) {
  const out = [];
  const withoutCode = text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
  for (const m of withoutCode.matchAll(/(?:^|\s)@((?:\.{0,2}\/)?[\w.-][\w./-]*)/gm)) {
    if (/\.\w+$/.test(m[1]) && !m[1].includes("@")) out.push(m[1]);
  }
  return out;
}
function lint(text, kind, rel) {
  const findings = kind === "hook-script" ? [] : hiddenCharacters(text);
  if (TEXT.has(kind)) findings.push(...textFindings(text, kind), ...secretFindings(text));
  else if (kind === "docs") findings.push(...docsFindings(text));
  else if (kind === "settings") findings.push(...settingsFindings(text, rel));
  else if (kind === "mcp") findings.push(...mcpFindings(text));
  else if (kind === "other-agent") findings.push(...otherAgentFindings(text, rel), ...secretFindings(text));
  else if (kind === "hook-script") {
    for (const hit of commandHits(text, "command")) findings.push({ rule: hit.rule, severity: hit.severity, line: lineAt(text, hit.index), message: hit.message });
  }
  const seen = /* @__PURE__ */ new Set();
  return findings.sort((a, b) => a.severity === b.severity ? a.line - b.line : a.severity === "warn" ? -1 : 1).filter((f) => {
    const key = `${f.rule}:${f.line}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function guardHome() {
  const custom = process.env.OVERSEER_HOME?.trim();
  return custom ? path.resolve(custom.replace(/^~(?=$|[\\/])/, os.homedir())) : path.join(os.homedir(), ".overseer");
}
var stateFile = (root) => path.join(guardHome(), "trust", "repos", `${sha256(root).slice(0, 24)}.json`);
var ledgerFile = () => path.join(guardHome(), "trust", "ledger.jsonl");
function loadState(root) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    return state?.v === 1 && state.root === root && isObject(state.files) ? state : null;
  } catch {
    return null;
  }
}
function writePrivate(file, data, append = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 448 });
  if (append) return fs.appendFileSync(file, data, { mode: 384 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode: 384 });
  fs.renameSync(temp, file);
}
function saveState(scan, previous, alerted, by, version2) {
  const files = {};
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
      alerted: alerted.has(e.path) || before?.sha256 === e.sha256 && before.alerted || void 0
    };
  }
  if (scan.since && previous) {
    for (const [rel, file] of Object.entries(previous.files)) if (!(rel in files) && !scan.removed.includes(rel)) files[rel] = file;
  }
  const state = { v: 1, rules: RULES_VERSION, root: scan.root, scannedAt: (/* @__PURE__ */ new Date()).toISOString(), head: scan.head, files };
  writePrivate(stateFile(scan.root), JSON.stringify(state));
  const at = state.scannedAt;
  const lines = [
    ...scan.files.filter((e) => e.status !== "seen").map((e) => ({ v: 1, at, root: scan.root, head: scan.head, path: e.path, kind: e.kind, sha256: e.sha256, event: e.status === "changed" ? "changed" : "seen", findings: e.findings.map(({ rule, severity, line }) => ({ rule, severity, line })), by, overseer: version2 })),
    ...scan.removed.map((rel) => ({ v: 1, at, root: scan.root, head: scan.head, path: rel, event: "removed", by, overseer: version2 }))
  ];
  if (lines.length) writePrivate(ledgerFile(), lines.map((line) => `${JSON.stringify(line)}
`).join(""), true);
}
var statOf = (file) => {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
};
var GuardError = class extends Error {
};
function entryOf(root, rel, kind, previous) {
  const abs = path.join(root, rel);
  let lstat;
  try {
    lstat = fs.lstatSync(abs);
  } catch {
    return null;
  }
  const findings = [];
  if (lstat.isSymbolicLink()) {
    let target;
    try {
      target = fs.realpathSync(abs);
    } catch {
      return null;
    }
    const inside = posix(path.relative(fs.realpathSync(root), target));
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      return { path: rel, kind, sha256: sha256(`link:${target}`), size: 0, findings: [{ rule: "G13", severity: "warn", line: 1, message: `is a link to ${shown(target.replace(os.homedir(), "~"), 80)}, outside the repository, which Claude Code would read as this file` }] };
    }
  }
  const stat = statOf(abs);
  if (!stat?.isFile()) return null;
  const cached = previous?.rules === RULES_VERSION ? previous.files[rel] : void 0;
  if (cached && cached.kind === kind && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return { path: rel, kind, sha256: cached.sha256, size: stat.size, findings: cached.findings };
  if (stat.size > MAX_BYTES) {
    return { path: rel, kind, sha256: sha256(`size:${stat.size}:${stat.mtimeMs}`), size: stat.size, findings: [{ rule: "G01", severity: "info", line: 1, message: `is over ${MAX_BYTES >> 20} MB, so guard didn't read it` }] };
  }
  const data = fs.readFileSync(abs);
  findings.push(...lint(data.toString("utf8"), kind, rel));
  return { path: rel, kind, sha256: sha256(data), size: stat.size, findings };
}
function scanRepo(root, options = {}) {
  const real = fs.realpathSync(root);
  const previous = options.previous === void 0 ? loadState(real) : options.previous;
  const kinds = /* @__PURE__ */ new Map();
  for (const rel of listFiles(real)) kinds.set(rel, kindOf(rel));
  const entries = [];
  const add = (rel, kind) => {
    const entry = entryOf(real, rel, kind, previous);
    if (entry) entries.push(entry);
    return entry;
  };
  for (const [rel, kind] of kinds) add(rel, kind);
  const commands = [];
  for (const e of entries) {
    if (e.kind !== "settings" && e.kind !== "mcp") continue;
    try {
      const json = parseJsonc(fs.readFileSync(path.join(real, e.path), "utf8"));
      if (isObject(json)) {
        if (e.kind === "settings") commands.push(...settingsCommands("", json).map((c) => c.command));
        if (isObject(json.mcpServers)) {
          for (const server of Object.values(json.mcpServers)) if (isObject(server)) commands.push(commandText(server));
        }
      }
    } catch {
    }
  }
  for (const rel of scriptsRun(real, commands)) {
    if (kinds.has(rel)) continue;
    kinds.set(rel, "hook-script");
    add(rel, "hook-script");
  }
  const queue = entries.filter((e) => e.kind === "instructions").map((e) => ({ rel: e.path, depth: 0 }));
  while (queue.length) {
    const { rel, depth } = queue.shift();
    if (depth >= 5) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(real, rel), "utf8");
    } catch {
      continue;
    }
    for (const target of imports(text)) {
      const imported = posix(path.relative(real, path.resolve(real, path.posix.dirname(rel), target)));
      if (imported.startsWith("..") || path.isAbsolute(imported)) continue;
      if (kinds.get(imported) === "docs") {
        const at = entries.findIndex((e) => e.path === imported);
        if (at >= 0) entries.splice(at, 1);
      } else if (kinds.has(imported)) continue;
      kinds.set(imported, "instructions");
      if (add(imported, "instructions")) queue.push({ rel: imported, depth: depth + 1 });
    }
  }
  let files = entries.map((e) => {
    const before = previous?.files[e.path];
    const status = !previous ? "first" : !before ? "new" : before.sha256 !== e.sha256 ? "changed" : "seen";
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
function changedSince(root, ref) {
  if (!isGitRepo(root)) throw new GuardError(`--since needs a git repository, and ${root} isn't in one.`);
  if (!/^[\w./@{}^~-]+$/.test(ref) || ref.startsWith("-") || git(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) === null) {
    throw new GuardError(`${ref} isn't a commit this repository has. In a shallow clone, fetch it first, such as with git fetch --depth=1 origin ${ref}.`);
  }
  const out = git(root, ["diff", "--name-only", "-z", "--no-renames", "--relative", ref, "HEAD"]);
  if (out === null) throw new GuardError(`git couldn't compare ${ref} with HEAD.`);
  return new Set(out.split("\0").filter(Boolean));
}
var warnings = (e) => e.findings.filter((f) => f.severity === "warn");
var KIND_LABEL = {
  instructions: "instructions",
  agent: "agent",
  skill: "skill",
  command: "command",
  "output-style": "output style",
  settings: "settings",
  mcp: "MCP servers",
  "hook-script": "run by a hook or MCP server",
  "other-agent": "another tool's config",
  docs: "docs"
};
var kindLabel = (e) => e.kind === "settings" && e.path.toLowerCase().endsWith("settings.local.json") ? "local settings" : KIND_LABEL[e.kind];
function toPointOut(scan, previous) {
  return scan.files.filter((e) => {
    const before = previous?.files[e.path];
    if (warnings(e).length) return !(before?.sha256 === e.sha256 && before.alerted);
    const moved = !scan.first && (e.status === "new" || e.status === "changed");
    return moved && (e.kind === "hook-script" || RUNS.has(e.kind) && e.findings.length > 0);
  });
}
function describe(e, before) {
  const known = new Set((before ?? []).map((f) => `${f.rule}:${f.message}`));
  const fresh = warnings(e).filter((f) => !known.has(`${f.rule}:${f.message}`));
  const first = fresh[0] ?? warnings(e)[0] ?? e.findings[0];
  const change = e.status === "new" ? "new since the last session" : e.status === "changed" ? "changed since the last session" : "";
  const what = first ? first.message : e.kind === "hook-script" ? "is run by a hook or MCP server" : "has nothing flagged";
  const more = warnings(e).length > 1 ? ` (+${warnings(e).length - 1} more)` : "";
  return `${e.path}${change ? ` (${change})` : ""} ${what}${more}`;
}
function sessionNotes(scan, points, previous = null) {
  if (!points.length) return {};
  const total = scan.files.filter((e) => e.kind !== "docs").length;
  const lines = points.map((e) => describe(e, previous?.files[e.path]?.findings));
  const user = `Overseer guard: ${points.length} of ${total} agent-config file${total === 1 ? "" : "s"} here need${points.length === 1 ? "s" : ""} a look. ${clip(lines.slice(0, 2).join("; "), 420)}${lines.length > 2 ? `; and ${lines.length - 2} more` : ""}. Free check, nothing sent; /overseer:guard for details.`;
  const claude = [
    "Overseer guard, a free local lint of this project's agent configuration, found files the user hasn't reviewed yet. They came with the repository or changed since the last session, and their contents are unverified:",
    ...points.slice(0, 20).map((e) => `- ${e.path} (${kindLabel(e)}): ${e.findings.filter((f) => f.severity === "warn").map((f) => `${RULE_SHORT[f.rule]}: ${f.message} (line ${f.line})`).join("; ") || describe(e).slice(e.path.length + 1)}`),
    points.length > 20 ? `- and ${points.length - 20} more` : "",
    "The user can review them with /overseer:guard, or npx @adamsaou/overseer guard in a terminal."
  ].filter(Boolean);
  return { user, claude: clip(claude.join("\n"), 6e3) };
}
var RULE_SHORT = {
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
  G13: "G13 links outside"
};
var clip = (text, n) => text.length > n ? `${text.slice(0, n - 1)}\u2026` : text;
function watchPaths(scan) {
  const paths = new Set(scan.files.filter((e) => e.kind !== "docs").map((e) => path.join(scan.root, e.path)));
  for (const rel of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", "CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", ".vscode/tasks.json"]) paths.add(path.join(scan.root, rel));
  return [...paths].slice(0, 500);
}
function projectFolder(dir) {
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return null;
  }
  if (real === path.parse(real).root || real === fs.realpathSync(os.homedir())) return null;
  return statOf(real)?.isDirectory() ? real : null;
}

// lib/guard-hook.ts
var off = (value) => OFF.test(value?.trim() ?? "");
function version() {
  try {
    return JSON.parse(fs2.readFileSync(path2.join(process.env.CLAUDE_PLUGIN_ROOT ?? "", ".claude-plugin", "plugin.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
function sessionStart(input) {
  const root = projectFolder(process.env.CLAUDE_PROJECT_DIR || input.cwd || "");
  if (!root) return null;
  const previous = loadState(root);
  const scan = scanRepo(root, { previous });
  const points = toPointOut(scan, previous);
  const notes = sessionNotes(scan, points, previous);
  saveState(scan, previous, new Set(points.filter((e) => warnings(e).length).map((e) => e.path)), "session-start", version());
  return {
    ...notes.user ? { systemMessage: notes.user } : {},
    hookSpecificOutput: { hookEventName: "SessionStart", ...notes.claude ? { additionalContext: notes.claude } : {}, watchPaths: watchPaths(scan) }
  };
}
function fileChanged(input) {
  const root = projectFolder(process.env.CLAUDE_PROJECT_DIR || input.cwd || "");
  if (!root || typeof input.file_path !== "string") return null;
  const previous = loadState(root);
  const scan = scanRepo(root, { previous });
  const points = toPointOut(scan, previous);
  saveState(scan, previous, new Set(points.filter((e) => warnings(e).length).map((e) => e.path)), "file-changed", version());
  const lines = points.map((e) => describe(e, previous?.files[e.path]?.findings).replace(/ \((new|changed) since the last session\)/, " (changed during this session)"));
  return {
    ...lines.length ? { systemMessage: `Overseer guard: ${lines.slice(0, 2).join("; ")}${lines.length > 2 ? `; and ${lines.length - 2} more` : ""}. /overseer:guard for details.` } : {},
    watchPaths: watchPaths(scan)
  };
}
function main() {
  const stdin = fs2.readFileSync(0, "utf8");
  const input = JSON.parse(stdin);
  if (off(process.env.OVERSEER_GUARD) || off(process.env.OVERSEER_HOOK)) {
    const root = projectFolder(process.env.CLAUDE_PROJECT_DIR || input.cwd || "");
    if (!root || !repositoryTurnsGuardOff(root)) return;
  }
  const event = process.argv[2];
  let out = null;
  try {
    out = event === "session-start" ? sessionStart(input) : event === "file-changed" ? fileChanged(input) : null;
  } catch (err) {
    if (event === "session-start") out = { systemMessage: `Overseer guard couldn't check this project's agent configuration: ${err.message}` };
  }
  if (out) fs2.writeSync(1, JSON.stringify(out));
}
try {
  main();
} catch {
}
