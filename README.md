# Agent Eval Harness

Measures whether a coding agent actually fixed the bug — and whether it was honest about it.

## Status

No measurement sweep has been recorded here: there is no `eval.db`, no `report.html`, and
no headline number in this README, because inventing one would be worse than having none.
Every code path that would spend money is written so it throws rather than silently
defaulting — `costUsd` throws on an unpriced model, `requireKey` throws before the first
API call, the cache assertion aborts a sweep rather than reporting cost numbers it can't
trust. Keys, where they exist at all, live in a gitignored `.env.local`; none of the five
gate commands reads one, and none is checked in.

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

One line in `src/variants.ts`. Swapping the entire vendor is still one:

    anthropic:      { ...baseline, provider: "anthropic", model: "claude-sonnet-5" },
    "gemini-flash": { ...baseline, provider: "google",    model: "gemini-2.5-flash" },

That is the argument for building a harness instead of a script.

## Provider support

Three adapters ship behind the same two-method interface (`start` → `step`, plus
`prewarm`), all unit-tested:

| Adapter | API | Live traffic behind anything checked in? |
|---|---|---|
| `src/provider/openai.ts` | Responses | **No** — the unit tests mock the SDK; `recorded/openai-turn2.json` is hand-written. |
| `src/provider/anthropic.ts` | Messages | **No** — same, for `recorded/anthropic-turn2.json`. |
| `src/provider/google.ts` | `generateContent` | **No** — its responses are inline in the tests. |

**No artifact in this repo — test, fixture, number or sentence — is derived from a live API
call.** That is a claim about what is checked in, and it is checkable: every response the
tests see comes from a mocked SDK, and the five gate commands make no network call. It is
deliberately *not* a claim about what anyone has ever run at a shell with a key of their own,
which this file has no way to attest to. Everything below is what the offline tests establish,
and nothing more.

One live call is still *owed*, and `src/provider/google.ts` says so in its header: the disputed
`candidatesTokenCount` question (TSD §5.3) is settled outright by a single `generateContent`
with thinking on. Its answer is recorded nowhere in this repo, which means it is unanswered
here. Whoever makes that call writes the verdict into that header.

The recorded response fixtures — `recorded/openai-turn2.json` and
`recorded/anthropic-turn2.json` — are hand-written, not live captures, because no API key
was available; each says so in its own `_comment`. The Google tests keep their responses
inline in the test files for the same reason, rather than putting hand-written JSON in a
directory called `recorded/`. All of them are faithful to the documented payload shapes,
and replacing them with real captures (`npm run record` for OpenAI) is the first thing to
do once a key exists.

The reason three adapters exist rather than one is the usage accounting, which is
different in every vendor and silently wrong if you assume otherwise:

- **OpenAI** — `input_tokens` *includes* cached, so cached is subtracted; `output_tokens`
  already includes reasoning.
- **Anthropic** — `input_tokens` *excludes* cached, so subtracting would double-discount;
  reasoning tokens are not reported at all.
- **Google** — `promptTokenCount` includes cached (subtract), and `candidatesTokenCount`
  *excludes* thoughts (add).

One unresolved question is encoded rather than papered over: a third-party source claims
Gemini's `candidatesTokenCount` already includes thinking tokens on the Developer API,
contradicting the SDK's own documentation. Without a key that cannot be settled, so
`usageArithmeticHolds()` re-derives the documented token identity from every real response
and warns once if it ever fails — a loud signal on the first live call instead of output
tokens quietly counted twice.

The Google adapter also throttles itself (~9 RPM by default, `GEMINI_MIN_INTERVAL_MS`) and
retries 429/5xx with backoff, because the Gemini free tier is roughly 10 RPM — below what
even `--concurrency 1` generates. Rate limits are a vendor fact, so they live in the
adapter, not in the runner.

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
