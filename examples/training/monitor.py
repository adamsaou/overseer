#!/usr/bin/env python3
"""Flags semantic-entropy drift across the checkpoints of a training run.

For each checkpoint, served behind an Anthropic Messages-compatible endpoint such as vLLM or a LiteLLM
proxy, monitor.py runs `overseer scan` with the same probes against the same reference, tags every line
with the checkpoint's step and appends the lines to one file. Then it follows each probe's Jensen-Shannon
divergence from the reference across the steps, and flags a probe whose divergence jumped since the step
before, or reached a level (--above, 0.3 by default) that a drift one answer at a time gets to without
ever jumping. It measures how far each checkpoint is from the reference, not how far it moved from the
checkpoint before: to confirm a change, scan the checkpoint against the one before it as the reference.

    python3 monitor.py --questions probes.jsonl --base-url http://localhost:8000 \\
        --checkpoint 1000=ckpt-1000 --checkpoint 1200=ckpt-1200 --reference-model base --yes

The history is the --out file, so a training loop can run this once per checkpoint and each run compares
with the steps already there. --report only reads the file and spends nothing.

Exit codes: 0 nothing flagged, 1 a probe was flagged, 2 the command line was wrong or Overseer didn't
start a scan (no --yes without a terminal, over --max-cost, or an Overseer without scan), 3 a checkpoint
couldn't be scanned in full.
Python 3.8 or newer, standard library only.
"""

import argparse
import json
import math
import os
import shlex
import subprocess
import sys

# Moved to each new version by scripts/sync-plugin.ts, which `npm version` runs.
DEFAULT_OVERSEER = "npx -y @adamsaou/overseer@0.1.1"
DEFAULT_ABOVE = 0.3


def fail(message, code):
    print(f"monitor.py: {message}", file=sys.stderr)
    sys.exit(code)


# A level, or "off" for none.
def level(value):
    if value.strip().lower() == "off":
        return None
    try:
        return float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f'takes a divergence such as 0.3, or off, not "{value}"')


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--questions", metavar="FILE", help="the probes, as for overseer scan")
    p.add_argument("--checkpoint", action="append", default=[], metavar="STEP=MODEL",
                   help="a checkpoint's step and the name the endpoint serves it under; repeatable, scanned in order")
    p.add_argument("--base-url", metavar="URL", help="the endpoint serving the checkpoints, the address in front of /v1/messages")
    p.add_argument("--api-key-env", metavar="VAR", help="the environment variable holding the endpoint's key, if it needs one")
    p.add_argument("--system", metavar="FILE", help="the checkpoints' system prompt; without one they get none")
    reference = p.add_mutually_exclusive_group()
    reference.add_argument("--reference", choices=["haiku", "sonnet", "opus"], help="compare with a Claude model")
    reference.add_argument("--reference-model", metavar="NAME", help="or with a model the endpoint serves, such as the base model")
    p.add_argument("--reference-base-url", metavar="URL", help="the reference's endpoint, if it isn't --base-url")
    p.add_argument("--reference-api-key-env", metavar="VAR", help="the reference endpoint's key, if it needs one; on --base-url, --api-key-env's by default")
    p.add_argument("--reference-system", metavar="FILE", help="the reference's system prompt; without one it gets none")
    p.add_argument("--n", type=int, default=4, help="answers from each model per probe, 2 to 16 (default 4)")
    p.add_argument("--jump", type=float, default=0.2, help="flag a probe whose divergence rose by at least this since the step before (default 0.2)")
    p.add_argument("--above", type=level, default=DEFAULT_ABOVE, metavar="LEVEL",
                   help="also flag a probe at the step its divergence reaches this, or off (default %(default)s)")
    p.add_argument("--out", default="scans.jsonl", metavar="FILE", help="where scan lines are appended and read back (default scans.jsonl)")
    p.add_argument("--run", help="a name for the training run, tagged on every line; only its lines are compared")
    p.add_argument("--tag", action="append", default=[], metavar="KEY=VALUE", help="another label for every line; repeatable")
    p.add_argument("--max-cost", metavar="USD", help="for each scan: don't start when its estimate is higher")
    p.add_argument("--yes", action="store_true", help="for each scan: don't ask before spending; needed without a terminal")
    p.add_argument("--overseer", default=os.environ.get("OVERSEER_CMD", DEFAULT_OVERSEER), metavar="CMD",
                   help="the command that runs Overseer (default $OVERSEER_CMD, or %(default)s)")
    p.add_argument("--report", action="store_true", help="only report on the steps already in --out, without scanning")
    args = p.parse_args()

    # The Jensen-Shannon divergence goes up to ln 2, about 0.69.
    if not 0 < args.jump <= math.log(2):
        p.error("--jump takes a divergence from 0 to 0.69, such as 0.2")
    if args.above is not None and not 0 < args.above <= math.log(2):
        p.error("--above takes a divergence from 0 to 0.69, such as 0.3, or off")
    if args.report:
        return args, []
    if not args.questions or not args.checkpoint or not args.base_url:
        p.error("--questions, --checkpoint and --base-url are required, unless --report")
    if not args.reference and not args.reference_model:
        p.error("give a reference to compare with: --reference haiku|sonnet|opus, or --reference-model")
    if args.reference and (args.reference_base_url or args.reference_api_key_env):
        p.error("--reference-base-url and --reference-api-key-env go with --reference-model")
    for tag in args.tag:
        if tag.split("=", 1)[0].strip() in ("step", "run"):
            p.error("monitor.py sets the step and run tags itself")
    checkpoints = []
    for value in args.checkpoint:
        step, _, model = value.partition("=")
        if not step.strip() or not model.strip():
            p.error(f'--checkpoint takes STEP=MODEL, such as 1200=ckpt-1200, not "{value}"')
        checkpoints.append((step.strip(), model.strip()))
    return args, checkpoints


def scan_command(args, step, model):
    cmd = shlex.split(args.overseer) + [
        "scan", "--questions", args.questions, "--n", str(args.n),
        "--target-base-url", args.base_url, "--target-model", model,
        "--tag", f"step={step}", "--out", args.out, "--json",
    ]
    if args.api_key_env:
        cmd += ["--target-api-key-env", args.api_key_env]
    if args.system:
        cmd += ["--system", args.system]
    if args.reference:
        cmd += ["--reference", args.reference]
    else:
        cmd += ["--reference-base-url", args.reference_base_url or args.base_url, "--reference-model", args.reference_model]
        # A reference on the checkpoints' own endpoint takes their key, unless it's given one.
        key_env = args.reference_api_key_env or (None if args.reference_base_url else args.api_key_env)
        if key_env:
            cmd += ["--reference-api-key-env", key_env]
    if args.reference_system:
        cmd += ["--reference-system", args.reference_system]
    if args.run:
        cmd += ["--tag", f"run={args.run}"]
    for tag in args.tag:
        cmd += ["--tag", tag]
    if args.max_cost:
        cmd += ["--max-cost", args.max_cost]
    if args.yes:
        cmd.append("--yes")
    return cmd


# An Overseer from before overseer scan answers "Unknown command" with exit code 2, which would read as a
# refused scan, so the command is tried once first.
def check_overseer(args):
    cmd = shlex.split(args.overseer) + ["scan", "--help"]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    except FileNotFoundError:
        fail(f"couldn't run {cmd[0]}. Install Node.js 22 or newer, or point --overseer at Overseer.", 2)
    if proc.returncode == 0:
        return
    if "Unknown command" in proc.stderr:
        fail(f'{args.overseer} has no scan command: that Overseer is older than monitor.py needs. Point --overseer at a newer one, such as "npx -y @adamsaou/overseer@<version>" or "node <checkout>/cli.ts".', 2)
    lines = proc.stderr.strip().splitlines()
    fail(f"{args.overseer} didn't run: {lines[-1] if lines else f'exit code {proc.returncode}'}", 2)


# Overseer's own messages, and its question before spending in a terminal, go straight to stderr and
# stdin; only the JSON summary comes back here.
def scan(args, step, model):
    cmd = scan_command(args, step, model)
    sys.stdout.flush()
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, universal_newlines=True)
    except FileNotFoundError:
        fail(f"couldn't run {cmd[0]}. Install Node.js 22 or newer, or point --overseer at Overseer.", 2)
    try:
        summary = json.loads(proc.stdout)
    except ValueError:
        summary = None
    return proc.returncode, summary


def read_lines(path, run):
    lines = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            try:
                line = json.loads(raw)
            except ValueError:
                continue  # blank, or cut short by a crash
            tags = line.get("tags") or {}
            if "step" in tags and (run is None or tags.get("run") == run):
                lines.append(line)
    return lines


# Divergences are only comparable between scans of the same run, against the same reference, with the
# same n and the same system prompt for the checkpoints.
def setting_of(line):
    target, reference = line.get("target") or {}, line.get("reference") or {}
    where = f'{reference["host"]}{reference.get("path") or ""}' if reference.get("host") else None
    return (line["tags"].get("run"), reference.get("model"), where, reference.get("system"), line.get("n"), target.get("system"))


def probe_of(line):
    return str(line["id"]) if line.get("id") is not None else f'{line["question"]} | {line["aspect"]}'


def step_order(steps):
    try:
        return sorted(steps, key=float)
    except ValueError:
        return steps


def series(lines):
    settings = {}
    for line in lines:
        s = settings.setdefault(setting_of(line), {"steps": [], "probes": {}})
        step = str(line["tags"]["step"])
        if step not in s["steps"]:
            s["steps"].append(step)
        # A probe scanned twice at one step keeps its latest line.
        s["probes"].setdefault(probe_of(line), {})[step] = line
    for s in settings.values():
        s["steps"] = step_order(s["steps"])
        # Lines arrive in the order scans finish, so the table goes by name.
        s["probes"] = dict(sorted(s["probes"].items()))
    return settings


def jumped(before, d, jump):
    return before is not None and d - before >= jump - 1e-9


# A level flags a probe once, at the step it reaches the level, not at every step it stays there. A drift of
# one answer per checkpoint never jumps: at n 4 the divergence goes 0, 0.10, 0.22, 0.38, 0.69.
def reached(before, d, above):
    return above is not None and d >= above - 1e-9 and (before is None or before < above - 1e-9)


def flags(s, jump, above):
    found = []
    for probe, by_step in s["probes"].items():
        before = None
        for step in s["steps"]:
            line = by_step.get(step)
            if line is None:
                continue
            d = line["divergence"]
            if jumped(before, d, jump) or reached(before, d, above):
                found.append((probe, step, before, line))
            before = d
    return found


def clip(text, n):
    return text if len(text) <= n else text[: n - 3] + "..."


def report(setting, s, flagged):
    run, model, host, system, n, _ = setting
    who = f"{model}@{host}" if host else model
    print(f"\nDivergence from {who}{' with its own system prompt' if system else ''} (n {n}){f', run {run}' if run else ''}, by step:")
    marks = {(probe, step) for probe, step, _, _ in flagged}
    width = max(5, min(28, max(len(p) for p in s["probes"])))
    cols = [max(6, len(step) + 2) for step in s["steps"]]
    # Each cell keeps a character after the number for the mark, so the numbers stay in line.
    print("  " + "probe".ljust(width) + "".join(step.rjust(w) + " " for step, w in zip(s["steps"], cols)))
    for probe, by_step in s["probes"].items():
        cells = []
        for step, w in zip(s["steps"], cols):
            line = by_step.get(step)
            value = "-" if line is None else f'{line["divergence"]:.2f}'
            cells.append(value.rjust(w) + ("!" if (probe, step) in marks else " "))
        print("  " + clip(probe, width).ljust(width) + "".join(cells))


def describe(probe, step, before, line, n, jump, above):
    d = line["divergence"]
    change = "" if before is None else f"{before:.2f} -> "
    rise = "" if before is None else f" (+{d - before:.2f})" if d >= before else f" ({d - before:.2f})"
    # Flagged by the level alone, without a jump.
    why = "" if jumped(before, d, jump) else f", reaching {above:.2f}"
    print(f"\n  {probe} at step {step}: divergence {change}{d:.2f}{rise}{why}")
    print(f'    "{clip(line["question"], 90)}" on {clip(line["aspect"], 80)}')
    for c in line["clusters"]:
        print(f"    {c['target']}/{n} checkpoint, {c['reference']}/{n} reference: {c['label']}")


def main():
    args, checkpoints = parse_args()
    incomplete = False
    if checkpoints:
        check_overseer(args)
    for step, model in checkpoints:
        print(f"Step {step}: scanning {model}")
        code, summary = scan(args, step, model)
        if summary is None:
            fail(f"step {step} wasn't scanned; Overseer's message is above.", 2 if code == 2 else 3)
        mean, top = summary["meanDivergence"], summary["maxDivergence"]
        spread = f", mean divergence {mean:.2f}, highest {top:.2f}" if summary["scanned"] else ""
        cost = summary["costUsd"]
        print(f"  {summary['scanned']} of {summary['questions']} probes scanned{spread}, {'under $0.01' if cost < 0.005 else f'about ${cost:.2f}'} in Anthropic API calls")
        if summary["failed"] or summary["skipped"]:
            incomplete = True

    try:
        lines = read_lines(args.out, args.run)
    except FileNotFoundError:
        fail(f"{args.out} doesn't exist yet. It's the file scans append to.", 2)
    if not lines:
        print(f"No scan lines with a step tag{f' and run {args.run}' if args.run else ''} in {args.out}.")
        sys.exit(3 if incomplete else 0)

    # A flag only alerts once: at the steps scanned now, or with --report at every step.
    scanned = {step for step, _ in checkpoints}
    alerts, marked = [], False
    for setting, s in series(lines).items():
        flagged = flags(s, args.jump, args.above)
        report(setting, s, flagged)
        marked = marked or bool(flagged)
        alerts += [(f, setting[4]) for f in flagged if args.report or f[1] in scanned]
    if marked:
        rule = f"a rise of {args.jump:.2f} or more since the step before" + (f", or the step a divergence reaches {args.above:.2f}" if args.above is not None else "")
        print(f"\n! marks {rule}.")
    if alerts:
        print(f"\n{len(alerts)} flagged:")
        for (probe, step, before, line), n in alerts:
            describe(probe, step, before, line, n, args.jump, args.above)
        sys.exit(1)
    print("\nNothing flagged." if not marked else "\nNothing new flagged.")
    sys.exit(3 if incomplete else 0)


if __name__ == "__main__":
    main()
