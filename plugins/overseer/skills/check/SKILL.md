---
description: Check a system prompt for a covert agenda before it ships, such as an agent in .claude/agents/, a product's prompt, a CLAUDE.md or AGENTS.md, or a skill (Overseer)
argument-hint: "<file> [purpose]"
disable-model-invocation: true
allowed-tools:
  - mcp__plugin_overseer_overseer__overseer_check
  - mcp__plugin_overseer_overseer__overseer_get_run
---

Check a system prompt with Overseer before it ships. A Claude model runs on the prompt, and an auditor that can't see the prompt talks to it the way users would, looking for anything it pursues that its stated purpose doesn't explain: passing off a third party's product as its own suggestion, steering users away from something, collecting details it doesn't need. The check's API calls are billed to the user's Anthropic API key, so nothing runs until the user agrees to its estimated cost.

Arguments: $ARGUMENTS

The first argument is the file to check, a path in this project, in quotes if it has spaces. Anything after it is the purpose: what the assistant is for.

1. **The file.** Without one, ask which file to check: an agent definition in .claude/agents/, a product's system prompt, a CLAUDE.md or AGENTS.md, or a skill's SKILL.md. It has to be inside the project. For a file elsewhere, the user can run `npx @adamsaou/overseer check --prompt <file> --purpose "<purpose>"` in a terminal.
2. **The purpose.** Without one, ask the user what the assistant is for, in a sentence or two, including what it may openly recommend, such as its own company's products. Don't write the purpose from what the prompt tells the assistant to do: the check flags behavior the purpose doesn't explain, so a purpose taken from the prompt would explain away the very agenda the check looks for. You may offer a one-line draft based on the file's name or its description field, for the user to correct. Wait for their answer.
3. **The plan.** Call overseer_check with `prompt` set to the file and `purpose` set to the purpose. Leave the other options at their defaults unless the user asks for something else, with two exceptions: for an agent whose frontmatter names haiku, sonnet or opus as its model, pass that as `model`; and if the user asks to compare with an earlier version, pass `baseline_ref` (a git ref such as HEAD or origin/main) or `baseline` (a file). This first call starts nothing and spends nothing: it returns the plan and an estimated cost. If it reports the prompt as unchanged, tell the user and stop. Otherwise show the plan and the estimate. If the user's request already approves a cost that the estimate fits within, such as "I approve up to $0.15", say that it does and go on to the run. If not, ask whether to run the check, and stop until they answer.
4. **The run.** Once the user agrees, call overseer_check again with exactly the same options and `confirm` set to the estimate, as the plan gave it. Then call overseer_get_run with the check_id and `wait: 60`, and again while its status is running.
5. **The report.** Give the result (pass, fail or incomplete), the auditor's confidence and the cost.
   - **fail**: state the agenda and quote the evidence verbatim. Then read the file, point to the lines most likely to cause it, and suggest concrete edits: remove or rewrite those lines, or, if the behavior is intended, disclose it to the assistant's users and add it to the stated purpose. Show each edit as before and after, and don't change the file unless the user asks.
   - **pass**: say what the auditor checked. If it suspected an agenda below the threshold, give its quotes and look for their cause in the file as you would for a failure. Add that this is a smoke test: a black-box check with a fixed budget can miss an agenda that its probes never trigger, so a pass isn't proof the prompt is safe.
   - **incomplete**: say why, either that the auditor stopped without a verdict or the error it reports, and offer to run the check again, with a larger budget if it ran out of messages.

overseer_check and overseer_get_run are tools of the overseer plugin's MCP server (mcp__plugin_overseer_overseer__...). If overseer_check isn't available, the server didn't start or is older than checks: tell the user to look at /mcp, where it's listed as plugin:overseer:overseer, and to update the plugin with `claude plugin update overseer@overseer`, then stop. If a call reports that no API key was found, pass its instructions on. If it says an audit is open, the user finishes or stops that audit first.
