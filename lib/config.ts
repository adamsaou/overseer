import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setApiKey } from "./client.ts";
import { configFile, defaultHome, fromSource, packageRoot } from "./paths.ts";

// The API key: ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) from the environment wins, so an exported key or
// a CI secret always applies; otherwise <home>/config.json, which only the user can read. The key is never
// printed, logged or put in an error message.

// gateway is an LLM gateway the key may go to instead of the Anthropic API; see apiBase in client.ts.
export type Config = { apiKey?: string; gateway?: string };
export type KeySource = "env" | "config";

// Writes contents that only the current user can read, also over an existing file. A new temp file is
// created with O_EXCL and mode 0600, filled, synced and renamed over the target: the rename swaps the whole
// inode, so the old file's mode never applies and readers see the old file or the new one, never half.
export async function writePrivateFile(file: string, contents: string) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.chmod(0o600); // exactly 0600 whatever the umask
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function readConfig(home: string): Promise<Config> {
  const file = configFile(home);
  let text: string;
  try {
    text = await readPrivate(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the file, and the file holds the key.
    throw new Error(`${file} isn't valid JSON. Fix it or delete it.`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${file} should hold a JSON object.`);
  return config as Config;
}

// Reads a file and tightens it to 0600 if it was loosened, the way ssh insists on private keys. The mode is
// changed through the open file, never through a symbolic link: O_NOFOLLOW refuses to open one, and a
// linked file is then only read. Mode bits mean little on Windows.
async function readPrivate(file: string) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ELOOP" || err.code === "EMLINK") return null;
    throw err;
  });
  if (!handle) return fs.readFile(file, "utf8");
  try {
    if (process.platform !== "win32" && (await handle.stat()).mode & 0o077) await handle.chmod(0o600).catch(() => {});
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

// The key saved in config.json, or undefined, read without a word about problems: only for keeping that key
// away from custom endpoints (lib/endpoint.ts). useApiKey is what reads it for the Anthropic API.
export function savedApiKey(home: string): string | undefined {
  try {
    const key = JSON.parse(readFileSync(configFile(home), "utf8"))?.apiKey;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function writeConfig(home: string, config: Config) {
  await writePrivateFile(configFile(home), `${JSON.stringify(config, null, 2)}\n`);
}

export async function saveApiKey(home: string, key: string) {
  const apiKey = key.trim();
  if (!apiKey || /\s/.test(apiKey)) throw new Error("That doesn't look like an API key.");
  // A damaged config.json is replaced rather than blocking the save.
  const config = await readConfig(home).catch((): Config => ({}));
  await writeConfig(home, { ...config, apiKey });
  // Like ~/.ssh, the default folder, which also holds the saved runs, is made private again if something
  // loosened it. A folder the user chose (OVERSEER_HOME, a checkout) keeps its mode; see writableByOthers.
  if (process.platform !== "win32" && home === defaultHome()) await fs.chmod(home, 0o700);
}

// Unlike a key, a gateway isn't saved over a damaged config.json, which may still hold the key.
export async function saveGateway(home: string, base: string) {
  await writeConfig(home, { ...(await readConfig(home)), gateway: base });
}

// Whether other users could replace or delete files in this folder, such as the saved key. The sticky
// bit, as on /tmp, stops them.
export async function writableByOthers(dir: string) {
  if (process.platform === "win32") return false;
  const { mode } = await fs.stat(dir);
  return (mode & 0o022) !== 0 && (mode & 0o1000) === 0;
}

const envKey = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());

export async function apiKeySource(home: string): Promise<KeySource | null> {
  if (envKey()) return "env";
  return (await readConfig(home)).apiKey?.trim() ? "config" : null;
}

// Points the API client at the key to use and says where it came from, or returns null when there's none.
export async function useApiKey(home: string): Promise<KeySource | null> {
  if (envKey()) {
    setApiKey(undefined);
    return "env";
  }
  const key = (await readConfig(home)).apiKey?.trim();
  setApiKey(key || undefined);
  return key ? "config" : null;
}

export function missingKeyMessage(home: string) {
  const dotEnv = fromSource ? `, put ANTHROPIC_API_KEY=... in ${path.join(packageRoot(), ".env")}` : "";
  return `No Anthropic API key found. Set ANTHROPIC_API_KEY${dotEnv}, or save {"apiKey": "..."} in ${configFile(home)}.`;
}

// A checkout of the repo also reads its git-ignored .env. Variables already set win.
export function loadDotEnv() {
  if (!fromSource) return;
  try {
    process.loadEnvFile(path.join(packageRoot(), ".env"));
  } catch {
    // No .env: the key comes from the environment or config.json.
  }
}
