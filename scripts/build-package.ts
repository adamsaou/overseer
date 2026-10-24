// Builds build/, the package npm ships. esbuild bundles the command (bin.ts) and the library (index.ts)
// with every dependency inside, so installing Overseer, as npx -y does for the plugin's server, downloads
// this one package and nothing else: no dependency can change under it, and the provenance npm attaches
// covers all the code that runs. tsc writes the library's type declarations, and the licenses of the
// bundled packages go in THIRD-PARTY-LICENSES.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "build");
fs.rmSync(out, { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { bin: "bin.ts", index: "index.ts" },
  outdir: out,
  bundle: true,
  // The commands load each other lazily (bin.ts checks the Node.js version before anything else loads, and
  // mcp and study load on demand), so each stays its own chunk, with the code they share in chunks of its own.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  format: "esm",
  platform: "node",
  target: "node22",
  // Kept readable: what runs on your machine can be read in build/.
  minify: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// The packages the bundle took code from, with their license texts.
const packages = new Map<string, string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.set(match[1], path.join(root, "node_modules", match[1]));
}
const sections = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  if (!manifest.license) throw new Error(`${name} doesn't say what license it's under, so it can't be bundled.`);
  const files = fs.readdirSync(dir).filter((file) => /^(licen[cs]e|notice|copying)/i.test(file)).sort();
  const texts = files.map((file) => fs.readFileSync(path.join(dir, file), "utf8").trim());
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  // A package can name its license without shipping the text, as standardwebhooks does.
  const missing = texts.length ? [] : [`The package ships no license file; its text is in ${repository ?? "the package's source"}.`, ""];
  return [`## ${name} ${manifest.version}`, "", `License: ${manifest.license}`, "", ...missing, ...texts.flatMap((text) => ["```text", text, "```", ""])].join("\n");
});
fs.writeFileSync(
  path.join(out, "THIRD-PARTY-LICENSES.md"),
  `# Third-party licenses\n\nOverseer's package bundles code from these packages, under their own licenses.\n\n${sections.join("\n")}`,
);

// Declarations only: the JavaScript is esbuild's.
execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.build.json")], { stdio: "inherit" });

const size = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`build/: ${Object.keys(result.metafile.outputs).length} files, ${(size / 1024).toFixed(0)} KB of JavaScript, bundling ${packages.size} packages.`);
