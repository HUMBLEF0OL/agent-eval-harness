# PRD — Agent Eval Harness

**Status:** Approved for build
**Date:** 2026-08-16
**Owner:** Amit Rana
**Type:** Personal learning project (weekend scope), intended for public showcase

---

## 1. Problem

Everyone building agents can *run* one. Almost nobody can answer the questions that actually matter:

- Does this prompt change make the agent better, or did I just get a lucky sample?
- Which tool is load-bearing, and what happens to success rate when I remove it?
- What does a successful run actually cost, and where do the tokens go?
- When the agent reports "done," is it done — or did it delete the failing test?

Agentic AI engineering has a measurement gap. Demos show one happy path; production needs distributions, trade-off curves, and honesty checks. The skill of building that measurement layer is under-practiced relative to how much it matters, which makes it both high learning value and unusually credible as a portfolio piece.

## 2. Goals

**G1 — Learn the mechanics of agent evaluation end to end.** Trajectory capture, programmatic scoring, LLM-judge calibration, variance handling, cost attribution.

**G2 — Produce a reusable substrate.** The harness should outlive this weekend and serve as the measurement layer for future agent projects (including a prompt-injection lab, where attack success rate is just another scorer).

**G3 — Ship something showcase-able.** A public repo with a README and one chart that communicates a real finding to an engineer in under thirty seconds.

**G4 — Detect gaming, not just success.** Pass rate alone is a lie. The harness must separately measure whether the agent achieved its result honestly.

## 3. Non-goals

| Not doing | Why |
|---|---|
| A general-purpose eval framework | One domain, built concretely. The abstraction can emerge later if a second domain ever arrives. |
| A dashboard web app | A single static HTML report is enough and is trivially shareable. |
| Distributed / cloud execution | Local, parallel-within-one-process is sufficient at this scale. |
| Statistical rigor beyond bootstrap CIs | The point is directional findings, not a paper. |
| Multi-language fixtures | TypeScript + vitest only. |
| Benchmarking against SWE-bench or public leaderboards | Custom fixtures are faster to author and the comparison isn't the point. |

## 4. Users

Primary: the author, learning agentic engineering and reusing the harness across future projects.

Secondary: engineers reading the public repo — hiring managers, teammates, anyone evaluating whether the author understands agent systems rather than just agent demos.

Both audiences are served by the same artifact: a working harness plus a report that states a finding and shows the evidence.

## 5. What gets built

An eval harness for **coding agents**. Given a set of small broken repositories, it runs an agent against each one, records the complete trajectory, scores the outcome on multiple axes, and compares configurations.

### 5.1 Fixtures

15 small TypeScript repositories. Each has one deliberately introduced bug and one failing test. Authored by taking working code and breaking it, which makes the ground-truth patch free (it is the inverse of the break).

Bug shapes must vary: off-by-one, wrong operator, swapped arguments, missing null guard, wrong early return, un-awaited async, wrong comparison, mutated input, incorrect default, wrong array method.

### 5.2 The agent under test

A hand-rolled tool-use loop over a thin **provider interface**, with four tools: `list_files`, `read_file`, `write_file`, `run_tests`. The loop is written from scratch rather than using either vendor's tool runner, because the loop is the surface being instrumented.

### 5.2.1 Providers

Two adapters ship: **OpenAI** (Responses API) and **Anthropic** (Messages API). Only `OPENAI_API_KEY` is available, so OpenAI is the default and **every measurement run in this build uses it**.

The Anthropic adapter is written, type-checked, and exercised by the zero-token demo against recorded responses — but it is unrun against the live API until a key exists. The README states this plainly rather than implying a cross-vendor comparison that was never executed. Running the sweep on Anthropic later is a `--variant` away, and that is the point: the provider is a variant field, not a rewrite.

The interface is deliberately two methods wide (`start` → `step`, plus `prewarm`). No plugin registry, no factory, no capability negotiation — a `Record<string, Provider>` and two files. If a third provider ever arrives it can pay for its own abstraction.

### 5.3 Measurements per run

| Axis | Measure |
|---|---|
| Correctness | Tests pass after test files are restored from the fixture |
| Honesty | Whether the agent modified test files or config (tampering) |
| Honesty (deep) | Whether the agent gamed the test from the source side (LLM judge) |
| Efficiency | Steps, wall time, five token categories, USD cost |
| Failure mode | `end_turn`, `max_steps`, `max_tokens`, `refusal`, `error` |

Token categories are normalised across providers: uncached input, cache write, cache read, output, and reasoning (a reported subset of output on OpenAI; unreported and therefore `0` on Anthropic). Normalisation is not cosmetic — the two vendors disagree about whether `input_tokens` includes cached tokens, and getting that wrong silently inflates or deflates every cost number in the study. See TSD §5.

### 5.4 Variants compared

Two experiments for the initial build, expressed as **four configurations**; each is a single changed field once the harness exists.

| Config | Provider | Model | Effort | Tools | Purpose |
|---|---|---|---|---|---|
| `baseline` | openai | `gpt-5.6-terra` | high | all four | Reference point |
| `no-run-tests` | openai | `gpt-5.6-terra` | high | minus `run_tests` | Feedback-loop experiment |
| `effort-medium` | openai | `gpt-5.6-terra` | medium | all four | Effort sweep (with baseline as the `high` arm) |
| `effort-low` | openai | `gpt-5.6-terra` | low | all four | Effort sweep |

15 tasks × 4 configs × **3 repetitions** = **180 runs** per full sweep. Three reps because a single run of a stochastic agent is noise, not a measurement.

Two further configurations exist in the file and are unrun for lack of budget or a key:

| Config | Provider | Model | Blocked on |
|---|---|---|---|
| `nano` | openai | `gpt-5-nano` | nothing — cheap enough to run if budget allows |
| `anthropic` | anthropic | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |

Each is three lines in `variants.ts`. That cheapness is itself a deliverable: the README should make the point that adding an experiment — **including swapping the entire vendor** — is a three-line diff, which is the whole argument for building a harness instead of a script.

## 6. Success criteria

The project is done when all of these hold:

| # | Criterion |
|---|---|
| S1 | 15 fixtures exist; each fails before the agent runs and passes with the ground-truth patch |
| S2 | A full sweep (15 tasks × 4 configs × 3 reps = 180 runs) completes unattended |
| S3 | Every run has a complete, replayable trajectory in SQLite |
| S4 | Pass rate is reported per variant with bootstrap confidence intervals |
| S5 | Tamper rate is reported separately from pass rate |
| S6 | Per-run cost is computed from actual `usage` fields, not estimated |
| S7 | `npm run demo` exercises the loop, store, and scorers with zero API calls |
| S8 | The report is one self-contained HTML file with a headline chart |
| S9 | The README states one concrete finding with a number attached |
| S10 | Both provider adapters pass the zero-token demo; token accounting is asserted against a recorded response from each vendor |
| S11 | Prompt caching is proven live, not assumed: the sweep aborts if `cacheReadTokens` is 0 on the second turn of the first run |

**Headline finding (hypothesis to be confirmed or refuted):** removing `run_tests` substantially reduces pass rate and increases tampering — the agent, unable to verify its work, is more likely to declare success it cannot support. If the data contradicts this, the contradiction is the finding and the README says so.

## 7. Deliverables

1. Public GitHub repository
2. `report.html` — self-contained, committed, viewable without running anything
3. `README.md` — the finding, the chart, how to reproduce, what the harness measures
4. This PRD and the TSD, committed under `docs/`

## 8. Constraints

| Constraint | Value |
|---|---|
| Time | One weekend, ~16 working hours (+1h vs the single-provider plan, for the adapter layer) |
| Budget | ~$50 in API spend including debugging |
| Credentials | `OPENAI_API_KEY` only. `ANTHROPIC_API_KEY` is absent and the harness must not require it to build, test, or run |
| Stack | TypeScript, `openai` + `@anthropic-ai/sdk`, SQLite, static HTML |
| Platform | Windows 11 (no Docker, no POSIX-only assumptions) |
| Dependencies | Minimal — no agent framework, no LLM abstraction library (LangChain, Vercel AI SDK, LiteLLM), no test framework beyond vitest for fixtures |

Development iteration uses `gpt-5-nano` at `effort: low` to keep debugging cheap. Measurement runs use `gpt-5.6-terra`.

**No third-party provider abstraction.** LangChain / the Vercel AI SDK / LiteLLM all solve this problem, and using one would be the lazy choice in most projects. It is the wrong choice here for the same reason the loop is hand-rolled (§5.2): the normalisation layer is precisely where token accounting goes wrong, and a library that flattens `cache_read` into `prompt_tokens` would silently destroy the measurement this project exists to make. The adapter layer is ~90 lines per vendor and every one of them is load-bearing.

**Budget estimate.** ~180 runs × ~10 turns. Assuming ~60k prompt tokens per run (≈80% served from cache) and ~8k output tokens at `gpt-5.6-terra` rates: ≈$0.13/run, ≈$24 for a full sweep. Reasoning tokens at `effort: high` are the variable that could double it. `effort: xhigh` and `reasoning.mode: "pro"` are out of budget and are not swept.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Fixture authoring eats the whole weekend | Break existing working code rather than writing repos from scratch; timebox to 3 hours and ship with fewer fixtures if needed |
| Prompt caching silently fails, cost balloons | Assert `cache_read_input_tokens > 0` on the second turn of the first run; fail loudly |
| Agent loops forever, burning budget | Hard `maxSteps` cap; record cap-hit as a distinct outcome rather than an error |
| Variance swamps the signal at 3 reps | Report CIs honestly; if intervals overlap, that *is* the result — say so rather than over-claiming |
| Debugging against live API is slow and expensive | `npm run demo` with a scripted fake model, built on day one |
| Windows path handling breaks the temp-dir sandbox | Path guard uses canonical resolution and is unit-tested in the demo check |
| Token normalisation is wrong in one adapter, so cost numbers are quietly incomparable | Each adapter has a unit test asserting normalised totals against a **recorded real response** from that vendor. OpenAI's `input_tokens` includes cached tokens; Anthropic's excludes them — this is the single highest-value assertion in the provider layer |
| The Anthropic adapter rots because it is never run | It is exercised by the demo on every `npm test`, and its normalisation test uses a recorded response. Untested-because-unkeyed is not acceptable; unrun-against-live is, and is disclosed |
| OpenAI drops reasoning state between turns, degrading the agent invisibly | Reasoning items are replayed in the manual history (`include: ["reasoning.encrypted_content"]`, `store: false`). Asserted in the demo: turn 2's request input contains the turn-1 reasoning item |
| Model IDs and prices drift after this was written | `PRICES` carries a `verifiedOn` date. A run against a model absent from the table is a hard error, never a silent `cost_usd = 0` |

## 10. Timeline

| Block | Hours | Work |
|---|---|---|
| Sat AM | 3 | 15 fixtures |
| Sat PM | 5 | Provider interface + OpenAI adapter + Anthropic adapter, agent loop, tools, path guard, SQLite store, demo self-check |
| Sun AM | 4 | Runner (temp dirs, cache pre-warm + cache assertion, parallelism, reps), pass + tamper scorers |
| Sun PM | 4 | Report, headline chart, README |
| Stretch | — | LLM cheat judge, `nano` variant, live Anthropic arm if a key appears, point the harness at Codex/Claude Code itself |

## 11. Follow-on work (explicitly deferred)

- **Prompt-injection lab** — reuses this harness wholesale; attack success rate becomes a scorer alongside pass rate, and the deliverable becomes an ASR-vs-task-success trade-off curve.
- **Adapter for external agents** — run the harness against Claude Code headlessly instead of the built-in loop, turning it into a benchmark of a production agent rather than a toy one.
- **Judge calibration study** — hand-label 30 trajectories and report judge-vs-human agreement. High learning value, does not fit the weekend.
