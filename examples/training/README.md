# Watching a training run with Overseer

Experimental. These two files watch the checkpoints of a training run for semantic-entropy drift, as [docs/training.md](../../docs/training.md#2-a-drift-monitor-across-checkpoints) describes.

| File | |
|---|---|
| `probes.jsonl` | Nine probe questions, each with the aspect its answers are compared on: which app or product the model recommends, which programming language, remote work or the office, energy sources, cars, learning formats, asking where the user lives, agreeing with a risky plan, and whether it admits to instructions |
| `monitor.py` | Runs `overseer scan` on each checkpoint against one reference, appends the lines to one file, and flags the probes whose divergence from the reference jumped since the step before or reached a level. Python 3.8 or newer, standard library only |

You need Node.js 22 or newer for Overseer, which `monitor.py` runs with `npx`, and Overseer 0.2.0 or newer, since 0.1.1 has no `overseer scan`; an Anthropic API key in `ANTHROPIC_API_KEY` for the clustering; and an endpoint that serves your checkpoints through Anthropic's Messages API, such as vLLM or a LiteLLM proxy.

```bash
python3 monitor.py --questions probes.jsonl --base-url http://localhost:8000 \
  --reference-model base --checkpoint 1000=ckpt-1000 --checkpoint 1200=ckpt-1200 --yes
```

For each `--checkpoint STEP=MODEL`, in order, it runs one scan of every probe, `--n` answers from the checkpoint and as many from the reference, tagged `step=STEP`, and appends one line per probe to `--out`. Then it reads that file back and prints a table of each probe's divergence by step, marking with `!` a probe whose divergence rose by `--jump` or more since the step before, and the step at which a probe's divergence reached `--above`. The level catches a drift of one answer at a time, which never jumps: at n = 4 it goes 0, 0.10, 0.22, 0.38, 0.69. The flagged probes are listed with their question, aspect and clusters, so you can see what changed.

## Options

| Option | |
|---|---|
| `--questions <file>` | The probes: JSON lines with `question`, `aspect` and an optional `id`, or lines written `question \| aspect` |
| `--checkpoint STEP=MODEL` | A checkpoint's step and the name the endpoint serves it under. Repeatable; scanned in the order given |
| `--base-url <url>` | The endpoint serving the checkpoints: the address in front of `/v1/messages` |
| `--api-key-env <var>` | The environment variable holding the endpoint's key, if it needs one |
| `--system <file>` | A system prompt for the checkpoints; without one they get none |
| `--reference haiku\|sonnet\|opus` | Compare with a Claude model |
| `--reference-model <name>` | Or with a model the endpoint serves, such as the base model; one of the two is required |
| `--reference-base-url <url>` | The reference's own endpoint, if it isn't on `--base-url` |
| `--reference-api-key-env <var>` | The variable holding the reference endpoint's key, if it needs one. A reference on `--base-url` uses `--api-key-env` unless you give this |
| `--reference-system <file>` | A system prompt for the reference; without one it gets none |
| `--n <n>` | Answers from each model per probe, 2 to 16, default 4. The thresholds below are for n = 4; at 4 no line's `p` goes below 0.029, so confirm a flag with a larger n |
| `--jump <x>` | The rise in divergence since the step before that's flagged, default 0.2 |
| `--above <x>` | Also flag a probe at the step its divergence reaches this, once, default 0.3. `off` turns it off, as for a Claude model as the reference, which differs from your model from the start |
| `--out <file>` | Where the lines are appended and read back, default `scans.jsonl` |
| `--run <name>` | Tags every line `run=<name>`, and compares only that run's lines |
| `--tag key=value` | Another label for every line; repeatable |
| `--max-cost <usd>` | For each scan: don't start when its estimate is higher |
| `--yes` | For each scan: don't ask before spending. Without a terminal, scans refuse to start without it |
| `--overseer <cmd>` | The command that runs Overseer, default `$OVERSEER_CMD` or `npx -y @adamsaou/overseer@0.4.0`, the version this `monitor.py` came with. A checkout runs as `--overseer "node <checkout>/cli.ts"`. `monitor.py` checks first that the command has `overseer scan` |
| `--report` | Only read `--out` and report, without scanning, which costs nothing |

The exit code is 0 when nothing was flagged, 1 when a probe was, 2 when the command line was wrong or Overseer didn't start a scan (no `--yes` without a terminal, or an estimate over `--max-cost`), and 3 when a checkpoint couldn't be scanned in full. In a terminal, without `--yes`, Overseer shows each scan's estimate and asks before it starts; Overseer's messages go straight to your terminal.

## From a training loop

The history is the `--out` file, so call `monitor.py` once per checkpoint, after it's saved and served, and each call compares with the steps already in the file. A flag alerts once, at the step where it happened; `--report` shows them all again.

```python
import subprocess

def watch(step, model_name):
    code = subprocess.call([
        "python3", "examples/training/monitor.py",
        "--questions", "examples/training/probes.jsonl",
        "--base-url", "http://localhost:8000", "--reference-model", "base",
        "--checkpoint", f"{step}={model_name}", "--run", "run-7",
        "--max-cost", "0.50", "--yes",
    ])
    if code == 1:
        print(f"Semantic drift at step {step}: see the table above.")
    elif code != 0:
        print(f"The drift monitor didn't finish at step {step} (exit {code}).")
```

## Reading the numbers

Divergences are only compared between lines of the same run with the same reference, the same n and the same checkpoint system prompt, so changing any of those starts a new table. Each is a checkpoint's distance from the reference, not how far it moved since the step before: two checkpoints can sit at the same distance and still differ, as when one pushes one app and the next another. To confirm a change, scan the checkpoint with the one before it as the reference, `--reference-model ckpt-1100`. At n = 4 one answer in four changing moves the divergence by about 0.1 and two by 0.22, which sampling alone can do: scan a flagged probe again with `--n 8` or more before acting on it. Keep aspects narrow, such as "which app it recommends", so that answers which agree land in one cluster; a broad aspect gives every answer a cluster of its own and the divergence its maximum, ln 2 ≈ 0.69, from noise alone.

The nine probes are estimated at $0.34 per checkpoint at n = 4, all of it the Claude Opus clustering, plus the reference's answers if it's a Claude model. The estimate prices each answer at the 4,000 characters the clustering reads at most, so shorter answers cost less. Your endpoint's own cost isn't counted.
