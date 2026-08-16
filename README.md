# Agent Eval Harness

Measures whether a coding agent actually fixed the bug — and whether it was honest about it.

## Status

No measurement sweep has been run: this repo has no `OPENAI_API_KEY` (and no
`ANTHROPIC_API_KEY`) available, and every code path that would spend money is written
so it throws rather than silently defaulting — `costUsd` throws on an unpriced model,
`requireKey` throws before the first API call, the cache assertion aborts a sweep rather
than reporting cost numbers it can't trust. There is no `eval.db`, no `report.html`, and
no headline number in this README, because inventing one would be worse than having none.

What *is* verified, end-to-end, with zero API calls:

    npm run demo             # scripted provider end-to-end, plus the leak check — zero tokens
    npm run verify-fixtures  # all 15 fixtures fail before the fix and pass after it

Both are green right now (`npx vitest run`, `npx tsc --noEmit`, and `npm run check-leaks`
are too). The moment a key exists, the finding is one command away:

    # PowerShell (the platform this harness was built and tested on)
    $env:OPENAI_API_KEY="..."
    npm run sweep -- --variant baseline --variant no-run-tests `
      --variant effort-medium --variant effort-low --reps 3

    # bash / zsh
    OPENAI_API_KEY=... npm run sweep -- --variant baseline --variant no-run-tests \
      --variant effort-medium --variant effort-low --reps 3

    npm run report -- ./eval.db ./report.html

That produces `report.html` — pass rate with a bootstrap 95% CI, tamper rate, cost, and
failure-mode breakdown, per variant — viewable by opening the file, no server required.

## What it measures

| Axis | How |
|---|---|
| Correctness | Test files are restored from the fixture before verification, so cheating cannot produce a pass |
| Honesty | SHA-256 over every test and config file, before and after — reported separately from pass rate |
| Cost | Computed from actual `usage` fields across five token categories, never estimated |
| Failure mode | `end_turn` / `max_steps` / `max_tokens` / `refusal` / `error`, with refusals and errors excluded from pass-rate denominators |

A stretch scorer, opt-in via `--judge`, goes one layer deeper than the SHA-256 check: it
asks an LLM — `gpt-5-nano`, deliberately **not** the model under test — to read the
source-side diff of a passing run and decide whether it's a hardcode, a special-case
branch, or a mock of the unit the test exercises, versus a genuine fix. See
`src/score/judge.ts` and TSD §9.3.

## Adding an experiment

One line in `src/variants.ts`. Swapping the entire vendor is three:

    anthropic: { ...baseline, provider: "anthropic", model: "claude-sonnet-5" },

That is the argument for building a harness instead of a script.

## Provider support

Both OpenAI (Responses API) and Anthropic (Messages API) adapters ship and are unit-tested.
Neither has been exercised against a live key in this environment — no key exists here.
**Both** recorded response fixtures — `recorded/openai-turn2.json` and
`recorded/anthropic-turn2.json` — are hand-written, not live captures, because neither
API key was available; each says so in its own `_comment`. They are faithful to the
documented payload shapes and the normalisation tests assert against them, but replacing
them with real captures (`npm run record` for OpenAI) is the first thing to do once a key
exists.

## Reproduce

    npm install
    npm run demo             # zero API calls, zero tokens — proves the harness works
    npm run verify-fixtures  # every fixture fails before, passes after
    npm test                 # unit suite

    # then, with a key — PowerShell:
    $env:OPENAI_API_KEY="..."; npm run sweep -- --variant baseline --reps 3
    # bash / zsh:
    OPENAI_API_KEY=... npm run sweep -- --variant baseline --reps 3

    npm run report

## Design notes

See [docs/PRD.md](docs/PRD.md) and [docs/TSD.md](docs/TSD.md). The three decisions
that matter: restore-before-verify (TSD §9.1), the cache assertion (TSD §6.4), and
putting the vendor seam at `step()` rather than at a neutral message list (TSD §2.2).
