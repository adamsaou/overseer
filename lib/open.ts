import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const onPath = (cmd: string) => (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir !== "" && existsSync(path.join(dir, cmd)));

function launcher(url: string): [string, string[]] | undefined {
  if (process.platform === "darwin") return ["open", [url]];
  // rundll32 hands the URL to the Windows shell with no cmd.exe parsing, so & and % in it stay literal.
  if (process.platform === "win32" || process.env.WSL_DISTRO_NAME) return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  // Headless, or SSH without a display: there's no browser to open, and xdg-open might start a text one.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return undefined;
  const cmd = ["xdg-open", "x-www-browser"].find(onPath);
  return cmd ? [cmd, [url]] : undefined;
}

// Opens an http(s) URL in the default browser without waiting for it. Returns false when nothing can open
// it, so callers should always print the URL as well.
export function openBrowser(url: string): boolean {
  const { protocol, href } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") throw new Error(`Not a web address: ${url}`);
  const found = launcher(href);
  if (!found) return false;
  // The browser has no use for the API key, so it doesn't inherit it.
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env;
  // Detached and unref'd: xdg-open would otherwise hold the terminal, and Windows kills attached children.
  const child = spawn(found[0], found[1], { stdio: "ignore", detached: true, windowsHide: true, env });
  child.on("error", () => {});
  child.unref();
  return true;
}
