# Overseer in CI

`overseer check` checks your assistant's system prompt for a covert agenda before it ships: the assistant runs on the prompt, and an auditor that can't see the prompt talks to it as a user would, looking for anything it pursues that its stated purpose doesn't explain. In CI it compares a changed prompt with the version it replaces, and stops before any API call when the prompt hasn't changed. [How it decides and how well it works](../README.md#check-your-assistant-in-ci) are in the README.

Recipes for four places to run it:

- [GitHub Actions](#github-actions), with the repo's own action.
- [GitLab CI](#gitlab-ci): [`examples/ci/gitlab-ci.yml`](../examples/ci/gitlab-ci.yml).
- [Any other CI](#any-other-ci-through-npx), through npx.
- [A git pre-push hook](#a-git-pre-push-hook): [`examples/ci/pre-push`](../examples/ci/pre-push).

Each needs an Anthropic API key in `ANTHROPIC_API_KEY`, from your CI's secret store.

## GitHub Actions

```yaml
# .github/workflows/overseer.yml
name: Overseer
on:
  pull_request:
    paths: ["prompts/support.md"]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: adamsaou/overseer@main   # pin a release tag or commit SHA
        with:
          prompt: prompts/support.md
          purpose: Answers billing and account questions for Acme, and may recommend Acme's own plans.
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action compares with the pull request's base commit, fails the job on a finding, annotates the prompt file and writes the verdict to the job summary. [Its inputs and outputs](../README.md#github-actions) are in the README.

## GitLab CI

[`examples/ci/gitlab-ci.yml`](../examples/ci/gitlab-ci.yml) is one job to copy into your `.gitlab-ci.yml`:

```yaml
overseer-check:
  image: node:24
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes:
        - prompts/support.md
  variables:
    OVERSEER_VERSION: "0.1.1"   # pin the version you've tried, so the check can't change under you
    PROMPT: prompts/support.md
    PURPOSE: "Answers billing and account questions for Acme, and may recommend Acme's own plans."
  script:
    # A shallow clone may not have the commit the merge request started from, so fetch it.
    - git cat-file -e "$CI_MERGE_REQUEST_DIFF_BASE_SHA^{commit}" 2>/dev/null
      || git fetch --quiet --depth=1 origin "$CI_MERGE_REQUEST_DIFF_BASE_SHA"
      || git fetch --quiet --unshallow
    - npx -y "@adamsaou/overseer@$OVERSEER_VERSION" check --prompt "$PROMPT" --purpose "$PURPOSE"
      --baseline-ref "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --summary overseer-check.md
  artifacts:
    when: always
    expose_as: Overseer check
    paths:
      - overseer-check.md
```

- **When it runs.** In merge request pipelines that change the prompt. `CI_MERGE_REQUEST_DIFF_BASE_SHA` is the commit the merge request's changes start from, so the check compares the new prompt with that version, and the entropy scans' reference runs on it. The first script line fetches that commit when the clone is too shallow to have it: just that commit, or the branch's whole history if the server won't send one commit on its own.
- **The key.** Add `ANTHROPIC_API_KEY` under Settings > CI/CD > Variables, masked. GitLab only gives a protected variable to pipelines on protected branches, so a key marked protected doesn't reach merge requests from ordinary branches. Pipelines for merge requests from forks run in the fork's project, without your variables, so their check stops with exit code 3 and the message that no key was found.
- **The result.** The job fails when the check finds an agenda, and `expose_as` links the Markdown summary, with the verdict and the quotes it rests on, from the merge request page. The exit codes are below. To report a finding without failing the pipeline while you try the check out, add `allow_failure: { exit_codes: 1 }`: the job then shows as a warning.
- **Several prompts.** Replace the job's `PROMPT` and `PURPOSE` variables with a matrix, one entry per prompt, and list every prompt under `changes`. Each prompt gets a job of its own, and one the merge request didn't change is skipped at no cost:

  ```yaml
    parallel:
      matrix:
        - PROMPT: prompts/support.md
          PURPOSE: "Answers billing and account questions for Acme, and may recommend Acme's own plans."
        - PROMPT: prompts/sales.md
          PURPOSE: "Answers questions about Acme's plans and recommends the one that fits."
  ```

## Any other CI, through npx

Any CI that has Node.js 22 or newer and git can run the check with npx. Fetch the branch to compare with, then check against it:

```bash
git fetch --quiet --depth=1 origin main
npx -y @adamsaou/overseer@0.1.1 check --prompt prompts/support.md \
  --purpose "Answers billing questions for Acme customers and may recommend Acme plans." \
  --baseline-ref FETCH_HEAD --summary overseer-check.md
```

`--baseline-ref` takes any git ref or commit the clone has, such as the target branch of a pull request, which most CI systems put in an environment variable of their own. `--baseline <file>` compares with a file instead, and with neither, the check compares the prompt with its stated purpose alone. It prints the live readout of the audit and then `✓ PASS` or `✗ FAIL`; `--summary <file>` writes the result as Markdown for the job page, and `--json` prints it as JSON instead of the readout.

| Exit code | |
|---|---|
| 0 | Nothing found, or the prompt is unchanged |
| 1 | An agenda found with at least `--fail-at` confidence (default 0.6) |
| 2 | A wrong flag, or an estimate over `--max-cost` (default $1.00), refused before anything is spent |
| 3 | The check couldn't finish: no API key, an API error, an auditor that stopped without a verdict, or an assistant that never answered the auditor, none of which counts as a pass |

- **Pin a version** you've tried, as above, so a check doesn't change under you between runs. The recipes on this page pin the version they were written for, and `npm version` moves them with each release.
- **Cost.** Sonnet auditing Sonnet at the defaults cost $0.10 to $0.14 a check on the example prompts, and Haiku auditing Haiku $0.003 to $0.02; the estimate shown before it starts errs high, $0.28 for the defaults. An unchanged prompt costs nothing and needs no key, which also makes it a free test of the wiring.
- **Nothing is saved.** Checks don't write to Overseer's data folder; keep the summary or the JSON as the job's artifact.
- **Your own model.** If the assistant runs on a model of yours behind an Anthropic Messages-compatible endpoint, check it there with `--target-base-url <url> --target-model <name>`, and `--target-api-key-env <var>` if the endpoint needs a key; these flags are new after 0.1.1. Your Anthropic key is never sent to it, and a prompt that holds the key is refused. [Training](training.md#serving-a-checkpoint) has the details.

## A git pre-push hook

[`examples/ci/pre-push`](../examples/ci/pre-push) runs the same check on your machine, before a push that changes a prompt goes out:

```bash
cp examples/ci/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

List your prompts at the top of the hook, one per line, as the file and what the assistant is for:

```bash
PROMPTS=$(cat << 'END'
prompts/support.md | Answers billing and account questions for Acme, and may recommend Acme's own plans.
END
)
```

- **What it checks.** The version of each listed prompt in the commits being pushed, which can differ from your working tree, against the version on the remote. For a new branch, that's where it leaves the remote's default branch (`origin/HEAD`, which `git remote set-head origin --auto` sets if it's missing). A push that doesn't change a listed prompt runs nothing.
- **What it stops.** A finding stops the push, with the verdict and its quotes on screen. A check that can't run, for want of a key or a network, or with an estimate over `--max-cost`, is reported and the push goes ahead, since CI checks again. `git push --no-verify` skips the hook.
- **Settings.** `OVERSEER` is the command that runs Overseer, `npx -y @adamsaou/overseer@0.1.1` unless you set it, and `OVERSEER_FLAGS` the options for every check, `--max-cost 0.50` unless you set it, such as `OVERSEER_FLAGS="--model haiku --auditor haiku --max-cost 0.10"`.
- **The key** comes from `ANTHROPIC_API_KEY`, or from a key saved once with `npx @adamsaou/overseer doctor`.
- **Cost.** Each push that changes a prompt runs one check of it: $0.10 to $0.14 measured with the defaults.

It's a bash script, so it runs on macOS, Linux, and Windows with Git for Windows.
