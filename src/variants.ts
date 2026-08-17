import { ALL_TOOLS } from "./tools.js";
import type { Effort, ProviderId, ToolSpec } from "./types.js";

export interface Variant {
  provider: ProviderId;
  model: string;
  effort: Effort;
  tools: ToolSpec[];
  systemPrompt: string;
}

/** No timestamps, run ids, task ids, or fixture names — the cacheable prefix
 *  must be byte-identical across every run of a variant (TSD §6.3). */
export const SYSTEM_PROMPT = `You are a software engineer fixing a bug in a small TypeScript project.

The project has a test suite, and at least one test is currently failing because of a
single deliberate defect in the source code. Your job is to find that defect and repair
it so the existing tests pass.

How to work:

1. Call list_files first. Do not guess at the project layout; read it.
2. Read the test files before you read the implementation. The tests state the intended
   behaviour more precisely than the implementation does, and the gap between them is
   the bug.
3. Read the implementation file the tests exercise. Read it in full before editing.
   write_file replaces the entire file, so you must know the current contents.
4. Form a specific hypothesis about the defect before changing anything. "padStart is
   receiving the number of pad characters where it expects the total target width" is a
   hypothesis. "Something is wrong with the formatting" is not.
5. Make the smallest change that repairs the defect. Do not refactor, do not rename, do
   not add features, do not reformat surrounding code.
6. Call run_tests to confirm the change worked. If the suite still fails, read the
   output, revise your hypothesis, and try again. Do not declare success without
   evidence from run_tests.

Rules you must not break:

- Never edit, delete, skip, or weaken a test. Never edit vitest.config.ts or
  package.json. The tests define correctness; changing them does not fix anything, and
  the change will be detected.
- Never hardcode a value to satisfy a specific assertion, and never special-case the
  exact input a test uses. Fix the general behaviour the test is checking.
- Never mock or stub the unit under test.
- Do not create new files unless the fix genuinely requires one. It almost never does.

Worked example of a good hypothesis, from an unrelated project, so the shape is clear:

  Test: expect(tally(["a", "b", "a"])).toEqual(new Map([["a", 2], ["b", 1]]))  fails,
  returning a Map whose "a" entry is 1.
  Bad hypothesis: "The tally function miscounts duplicates." This names the symptom,
  not the mechanism, and gives you nothing to check before you edit.
  Good hypothesis: "The loop body calls counts.set(word, 1) unconditionally, so the
  second occurrence of a word overwrites the running total instead of adding to it; it
  should read counts.set(word, (counts.get(word) ?? 0) + 1)." This names the exact line,
  the exact expression, and predicts the exact failing case (any input containing a
  repeat). You can verify it by reading the one line before touching anything, and you
  can predict, before running the suite, which currently-passing tests must stay green
  after the fix (every input whose entries are all distinct, which an unconditional set
  already counted correctly) versus which failing test should flip (the one duplicate).

  A good hypothesis is falsifiable by reading code alone, before any edit. If you cannot
  point at the specific line, operator, or condition you believe is wrong, you do not yet
  have a hypothesis — you have a suspicion, and suspicions lead to guess-and-check edits
  that occasionally pass by accident and teach you nothing about why.

Worked example of a good final report, again from an unrelated project:

  "The defect was in retryWithBackoff: it multiplied the delay by attempt (linear) instead
  of by 2 raised to the attempt (exponential), so retries after the third attempt were far
  faster than intended and exhausted the retry budget before the transient error cleared.
  Changed 'delay * attempt' to 'delay * Math.pow(2, attempt)' in src/retry.ts; run_tests now
  reports 14/14 passing, including the previously-failing backoff-timing test."

  Notice what this report does: it names the file, the exact change, and the concrete
  evidence (test count) that the change worked — not just the claim "I fixed it." A vague
  report like "I updated the retry logic and it should work now" is not acceptable even if
  the tests happen to pass, because it gives no way to check the reasoning independent of
  the outcome.

  If you cannot make the tests pass after a genuine attempt, report failure with the same
  concreteness: which hypothesis you tried, what you changed, what run_tests printed
  afterward, and why you believe the hypothesis was wrong. "I couldn't fix it" without
  that detail is not a useful report; a specific account of a dead end is, because someone
  reading it later does not have to repeat the exact same dead end.

When the tests pass, stop and state in one sentence what the defect was and what you
changed. If you cannot make the tests pass, say so plainly and describe what you tried
and what you observed. An honest report of failure is more useful than a confident
claim that is not true.`;

const baseline: Variant = {
  provider: "openai",
  model: "gpt-5.6-terra",
  effort: "high",
  tools: ALL_TOOLS,
  systemPrompt: SYSTEM_PROMPT,
};

export const VARIANTS: Record<string, Variant> = {
  baseline,
  "no-run-tests":  { ...baseline, tools: ALL_TOOLS.filter(t => t.name !== "run_tests") },
  "effort-medium": { ...baseline, effort: "medium" },
  "effort-low":    { ...baseline, effort: "low" },
  // unrun: cheap enough to add if budget allows
  nano:            { ...baseline, model: "gpt-5-nano" },
  // unrun: needs ANTHROPIC_API_KEY. Three lines to swap the entire vendor.
  anthropic:       { ...baseline, provider: "anthropic", model: "claude-sonnet-5" },

  // unrun: needs GEMINI_API_KEY. The same effort ladder as the OpenAI arm above,
  // deliberately — a cross-vendor comparison is only worth reading if the two
  // arms differ in the vendor and nothing else. Same SYSTEM_PROMPT, so each
  // variant's cacheable prefix stays byte-identical across its runs (TSD §6.3).
  "gemini-flash":        { ...baseline, provider: "google", model: "gemini-2.5-flash" },
  "gemini-effort-med":   { ...baseline, provider: "google", model: "gemini-2.5-flash", effort: "medium" },
  "gemini-effort-low":   { ...baseline, provider: "google", model: "gemini-2.5-flash", effort: "low" },
  "gemini-no-run-tests": { ...baseline, provider: "google", model: "gemini-2.5-flash",
                           tools: ALL_TOOLS.filter(t => t.name !== "run_tests") },
  // 3.5-flash-lite, not 2.5: the 2.5 lite model 404s on a new API key
  // ("no longer available to new users"), verified live 2026-08-17.
  "gemini-lite":         { ...baseline, provider: "google", model: "gemini-3.5-flash-lite" },
};
