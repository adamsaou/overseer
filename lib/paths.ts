import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Node won't strip types under node_modules, so this module being .ts means a checkout of the repo
// (npm start, ./cli.ts, node mcp.ts); an installed package runs the compiled .js.
export const fromSource = import.meta.filename.endsWith(".ts");

// Whether the module with this import.meta is the script node was started with. import.meta.main only
// arrived in Node.js 22.18 and 24.2; before that it's undefined, so the started file's real path decides.
export function isMain(meta: ImportMeta) {
  if (typeof meta.main === "boolean") return meta.main;
  try {
    return realpathSync(process.argv[1] ?? "") === meta.filename;
  } catch {
    return false;
  }
}

let root: string | undefined;

// The folder with this package's package.json. Walking up, instead of a fixed "..", finds it from lib/
// in a checkout and from build/lib/ once compiled.
export function packageRoot(): string {
  if (root) return root;
  for (let dir = import.meta.dirname; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return (root = dir);
    if (path.dirname(dir) === dir) throw new Error(`No package.json found above ${import.meta.dirname}`);
  }
}

// The web UI's pages, shipped with the package.
export const publicDir = () => path.join(packageRoot(), "public");

export const defaultHome = () => path.join(os.homedir(), ".overseer");

// Where runs, study results and config.json live. A checkout keeps its own runs/ and results/; an installed
// package uses ~/.overseer rather than its own folder, which npm may own and replaces on every upgrade.
export function dataHome(): string {
  const custom = process.env.OVERSEER_HOME?.trim();
  if (custom) return path.resolve(custom.replace(/^~(?=$|[\\/])/, os.homedir()));
  return fromSource ? packageRoot() : defaultHome();
}

export const runsDir = (home: string) => path.join(home, "runs");
export const resultsDir = (home: string) => path.join(home, "results");
export const configFile = (home: string) => path.join(home, "config.json");

export function packageVersion(): string {
  return JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")).version;
}

// For messages: relative to the working directory when inside it, otherwise with ~ for the home folder.
// Not relative to / or to the home folder itself, where "root/.overseer" or ".overseer" would read like
// a path somewhere else.
export function displayPath(file: string): string {
  const cwd = process.cwd();
  const home = os.homedir();
  const relative = path.relative(cwd, file);
  const project = cwd !== path.parse(cwd).root && cwd !== home;
  if (project && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}
