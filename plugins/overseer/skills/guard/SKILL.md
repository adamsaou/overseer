---
description: Check the files that steer Claude Code in this project for free, such as CLAUDE.md files, agents, skills, settings and MCP servers, and what attacks have used them for (Overseer guard)
argument-hint: "[git ref]"
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_overseer_overseer__overseer_guard
---

Check this project's agent configuration with Overseer guard: CLAUDE.md and AGENTS.md files, agents, skills, commands, settings, MCP servers, the scripts hooks run, and the files other tools run by themselves, such as VS Code tasks. Guard is free and local: it reads files, runs none of them and sends nothing anywhere.

Arguments: $ARGUMENTS

1. **The scan.** Call overseer_guard. If the arguments name a git ref, such as origin/main, pass it as `since` to check only what changed since then. Pass `all: true` if the user asks for every file.
2. **The report.** Lead with what's flagged, file by file, most serious first, in plain words: what the file makes happen, and when. For a hook or a helper command, say what runs and on which event, then read the script it runs if it's in the project, and say what that does. Read flagged files and scripts; never run a flagged command, script or MCP server to see what it does.
3. **What to do.** For each flagged file, say whether it looks like the project's own tooling or something unexpected, and what the user can do: remove or change the line, or keep it if it's theirs. Don't edit or delete anything unless the user asks. If they're about to work in a repository they didn't write, mention that guard can run before Claude Code starts: `npx @adamsaou/overseer guard install --git --global` checks every repository they clone.
4. **Limits.** Nothing flagged means none of guard's patterns matched, not that the files are safe: a reworded instruction can get past a pattern. For an instruction file that might carry an agenda, such as a CLAUDE.md, an agent or a skill, offer /overseer:check, which tests what the instructions make a model do. It's billed to the user's Anthropic API key and shows its cost first.

overseer_guard is a tool of the overseer plugin's MCP server (mcp__plugin_overseer_overseer__overseer_guard). If it isn't available, the server is older than guard: tell the user to update the plugin with `claude plugin update overseer@overseer`, or to run `npx @adamsaou/overseer guard` in a terminal, then stop.
