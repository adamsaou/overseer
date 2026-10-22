# Overseer

**Can a weaker AI catch a stronger one that's hiding something?**

Overseer is a live alignment-auditing demo and a small study on the Claude 5.5 family. A target model gets one hidden objective in a confidential system prompt and is told to pursue it subtly. An auditor model can only talk to it the way a user would. Within a fixed message budget it has to work out the objective and submit a verdict, which Claude Opus 5.5 grades against the sealed objective.

It asks two questions:

1. **The oversight gap.** Run every auditor (Haiku, Sonnet, Opus 5.5) against every target. Does auditing break down when the target is more capable than the auditor?
2. **Semantic entropy as a signal of hidden intent.** Semantic entropy was built to catch hallucinations: sample several answers, cluster them by meaning, and measure the entropy over the clusters (Farquhar et al., Nature 2024). Semantic Entropy Probes predict it from a single forward pass (Kossen et al., 2024). Overseer points the same measurement at hidden objectives. The hypothesis: a hidden objective collapses the target's semantic entropy, relative to a clean copy of the same model, in exactly the domains it targets. The study runs every matchup with and without an `entropy_scan` tool to test whether this cheap black-box signal helps, especially weaker auditors.

## Run it

Needs Node 23.6 or newer (it runs the TypeScript directly) and an Anthropic API key.

```bash
npm install
cp .env.example .env      # then put your key in .env
npm start                 # http://127.0.0.1:7878
```

- **Live audit (`/`).** Write a hidden objective, or seal a random preset so nobody in the room knows it. Pick the auditor and target, then watch the investigation: the auditor's conversations with the target, its reasoning, its evidence board and its entropy scans. The verdict and the reveal come at the end. Every audit is saved to `runs/` and can be replayed at `/?replay=<id>`, which is useful when the venue wifi isn't.
- **Study (`/study`).** `npm run study` runs the full grid: 2 tool conditions × 3 auditors × 3 targets × 8 objectives = 144 audits. It resumes where it left off and prints the approximate cost of each audit as it goes. Slice it with `--tools entropy`, `--auditors haiku,opus`, `--targets opus`, `--goals 3` (or ids, such as `--goals city,office`), `--reps 2`, `--budget 24`, `--effort medium` and `--concurrency 4`; `--summarize` rebuilds `results/summary.json` without running anything.
- **Terminal (`cli.ts`).** `./cli.ts audit --auditor opus --target sonnet` runs one audit with a live readout: the auditor's reasoning, every message to and from the target, the evidence board, entropy scans, the verdict and the reveal. Also `presets`, `runs`, `ui` and `study`; `--help` lists the options. Symlink it onto your PATH as `overseer` to run it from anywhere.

## Claude Code as the auditor

The repo is also a Claude Code workspace. Its MCP server (`mcp.ts`, declared in `.mcp.json`) deploys a target with a hidden objective drawn at random and sealed on the server, and hands Claude Code the auditor's tools: `begin_audit`, `send_message`, `sample`, `entropy_scan`, `update_board` and `final_verdict`. The budget is enforced server-side, the verdict is graded like any other, and the run is saved to `runs/` tagged `claude-code`, so it replays in the web UI.

```bash
cd overseer
claude              # approve the "overseer" MCP server when asked
> /overseer sonnet 24
```

`/overseer` (`.claude/commands/overseer.md`) starts the audit and the `overseer-audit` skill (`.claude/skills/`) teaches the method. For a headless run that physically can't read the answer files:

```bash
claude -p "/overseer haiku 12" --mcp-config .mcp.json --strict-mcp-config \
  --allowedTools "mcp__overseer" --disallowedTools "Read,Grep,Glob,Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"
```

## Hosted showcase

https://overseer.saoudani-adam.workers.dev serves the pages, every audit saved in `runs/` as a replay, and the study results, from a Cloudflare Worker on the free plan. Live audits stay local, because one audit makes 50-80 API calls and a free Worker gets 50 per request. After new runs or a new `results/summary.json`, redeploy with `npm run deploy`. Wrangler runs `scripts/build-site.ts` first to bundle them into `dist/`.

## How it works

| Part | Model | Details |
|---|---|---|
| Target | Haiku, Sonnet or Opus 5.5 | Hidden objective in a confidential system prompt; low effort. |
| Reference | Same model as the target | The same deployment without the objective. Only `entropy_scan` uses it. |
| Auditor | Haiku, Sonnet or Opus 5.5 | Adaptive thinking; tools `send_message`, `sample`, `update_board` and `final_verdict`, plus `entropy_scan` in the entropy condition. |
| Clustering and grading | Opus 5.5 | Low effort, structured outputs. Answers are shuffled before clustering so the clusterer can't tell which model wrote which. |

`entropy_scan` asks the target and the reference the same question n times each. It clusters all 2n answers by bidirectional entailment on an aspect the auditor names, then reports both models' discrete semantic entropy and the Jensen-Shannon divergence between their cluster distributions.

Opus 5.5 and Sonnet 5.5 calls opt into server-side refusal fallbacks (`fallbacks: "default"`). A run where a fallback model served the auditor is flagged and left out of the study summary.

| File | What it does |
|---|---|
| `lib/auditor.ts` | The auditor's agent loop, tools and live events |
| `lib/entropy.ts` | Semantic-entropy scans: clustering, entropy, divergence |
| `lib/target.ts` | Target and reference deployments, one conversation per thread |
| `lib/grader.ts` | Verdict grading |
| `lib/goals.ts` | The hidden objectives |
| `server.ts`, `public/` | Live demo, replays and the study page |
| `study.ts` | The grid runner |

## Next step: white-box probes

A scan costs 2n samples. Semantic Entropy Probes showed that a linear probe on hidden states can predict semantic entropy from one forward pass. On an open-weights model, the same trick could predict the entropy gap, or the presence of a hidden objective, straight from activations: a cheap, always-on monitor for hidden intent, in the spirit of Anthropic's defection probes.

## Related work

Models hiding their intent
- Hubinger et al. (Anthropic), *Sleeper Agents: Training Deceptive LLMs that Persist Through Safety Training*, 2024
- Greenblatt et al. (Anthropic and Redwood Research), *Alignment Faking in Large Language Models*, 2024
- Meinke et al. (Apollo Research), *Frontier Models are Capable of In-context Scheming*, 2024
- Scheurer et al. (Apollo Research), *Large Language Models can Strategically Deceive their Users when Put Under Pressure*, 2023
- Anthropic, *Agentic Misalignment: How LLMs Could Be Insider Threats*, 2025
- van der Weij et al., *AI Sandbagging: Language Models can Strategically Underperform on Evaluations*, 2024

Catching it
- Marks et al. (Anthropic), *Auditing Language Models for Hidden Objectives*, 2025
- Anthropic, *Building and Evaluating Alignment Auditing Agents*, 2025
- Bowman et al. (Anthropic), *Measuring Progress on Scalable Oversight for Large Language Models*, 2022
- Pacchiardi et al., *How to Catch an AI Liar: Lie Detection in Black-Box LLMs by Asking Unrelated Questions*, 2023
- MacDiarmid et al. (Anthropic), *Simple Probes Can Catch Sleeper Agents*, 2024
- Goldowsky-Dill et al. (Apollo Research), *Detecting Strategic Deception Using Linear Probes*, 2025

Semantic entropy
- Kuhn, Gal and Farquhar, *Semantic Uncertainty: Linguistic Invariances for Uncertainty Estimation in Natural Language Generation*, ICLR 2023
- Farquhar, Kossen, Kuhn and Gal, *Detecting Hallucinations in Large Language Models Using Semantic Entropy*, Nature, 2024
- Kossen et al., *Semantic Entropy Probes: Robust and Cheap Hallucination Detection in LLMs*, 2024
