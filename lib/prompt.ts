import readline from "node:readline";

// Terminal prompts. They write to stderr, so stdout stays clean for --json and pipes, and Ctrl-C exits
// with 130 as it does everywhere else.

export const canPrompt = () => Boolean(process.stdin.isTTY && process.stderr.isTTY);

// Reads a line without echoing anything, not even asterisks, for an API key.
export function askSecret(question: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve) => {
    let value = "";
    const stop = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      // Escape sequences are dropped: arrow keys, and the markers some terminals put around pasted text.
      const chars = [...chunk.toString("utf8").replace(/\x1b\[[\d;]*[~A-Za-z]/g, "")];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === "\x03") {
          stop();
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n" || ch === "\x04") {
          stop();
          // Whatever was typed ahead belongs to the next prompt; a \r\n line ending counts as one Enter.
          const rest = chars.slice(ch === "\r" && chars[i + 1] === "\n" ? i + 2 : i + 1).join("");
          if (rest) input.unshift(Buffer.from(rest));
          return resolve(value);
        }
        if (ch === "\x7f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

// Enter picks the fallback. End of input counts as no.
export function askYesNo(question: string, fallback: boolean): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    let answered = false;
    rl.on("SIGINT", () => {
      process.stderr.write("\n");
      process.exit(130);
    });
    rl.on("close", () => {
      if (answered) return;
      process.stderr.write("\n");
      resolve(false);
    });
    rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `, (answer) => {
      answered = true;
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a ? a === "y" || a === "yes" : fallback);
    });
  });
}
