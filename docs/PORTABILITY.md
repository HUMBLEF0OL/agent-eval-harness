# Portability

The plan's Global Constraints fixed the platform at Windows 11, and everything in this repo
was built and measured there. This document is the honest account of what it now takes to run
off Windows, what has been verified, and — the part that matters — what has not.

## Why it is not cosmetic

Two things here are genuinely platform-sensitive, and both sit on the measurement path:

1. **Scoring hashes file bytes.** `hashGuardedFiles` takes a SHA-256 over each guarded file.
   A CRLF checkout and an LF checkout of the same commit produce different digests. Within a
   single run the before/after comparison cancels out, so tamper detection is not *wrong* on
   Windows — but two platforms would report different hashes for the same fixture, and any
   future cross-machine comparison would be meaningless.
2. **Scoring spawns a child process.** `runVitest` and `verify-fixtures` run vitest in a
   sandbox. That is where `shell: true`, `npx` resolution, argument quoting and timeout
   signalling all differ by platform — and where a bug is silent, because a failed spawn looks
   exactly like a failed test.

## What makes it portable

| Mechanism | Where | What it fixes |
|---|---|---|
| `*.db binary` | `.gitattributes` | the six tracked sweep databases are the evidence behind every published figure, and they are SQLite. Left to `text=auto` detection, one wrong guess would rewrite bytes inside pages on checkout and corrupt the record — so it is stated, not detected |
| `* text=auto eol=lf` | `.gitattributes` | every checkout is LF, so fixture bytes and their hashes are identical on all three platforms — including on Windows, where `core.autocrlf=true` would otherwise win |
| No `shell: true` anywhere | `src/sandbox.ts`, `scripts/verify-fixtures.mjs`, `src/report.test.ts` | `process.execPath` runs the tool's own CLI entry directly. No `cmd.exe`/`/bin/sh` re-parsing, so arguments need no hand-quoting, paths with spaces work unchanged, and a timeout signals the real process instead of a shell that leaves the grandchild orphaned |
| `.split(path.sep).join("/")` | `tools.ts`, `score/tamper.ts`, `runner.ts`, `verify-fixtures.mjs` | every path the model or the database ever sees is forward-slashed, so trajectories and `tamperDetail` are comparable across platforms |
| `forceConsistentCasingInFileNames` | `tsconfig.json` | Windows and macOS resolve imports case-insensitively, Linux does not. Set explicitly so a mismatch fails here rather than only in CI |
| Platform-stable output | `scripts/check-leaks.mjs` | the "allowed directory" string is a literal `src/provider`, not `path.join(...)`, which used to print `src\provider/` on Windows and `src/provider/` on Linux |
| Sandboxes under `<repo>/.aeh-tmp/` | `src/sandbox.ts` | a Windows constraint kept deliberately: Node's ESM resolver will not cross drive letters, and `os.tmpdir()` is on `C:` while a repo may be on `E:`. Harmless on POSIX, where it is simply a directory — but the *reason* is Windows-only, and it is written down so nobody "simplifies" it back to `os.tmpdir()` |
| Node major axis | `.github/workflows/gates.yml` | `package.json` declares `engines: >=22`, so Node 22 is pinned on all three OSes and the newest major (26) additionally runs on Linux. An untested version claim is not a claim, and the native `better-sqlite3` build is the thing a Node major realistically breaks |
| Matrix CI | `.github/workflows/gates.yml` | runs the six zero-cost gates on `ubuntu-latest`, `windows-latest` and `macos-latest`, `fail-fast: false` so a red Linux does not hide the macOS answer |

## What has been verified, and how

Verified locally, on Windows:

- **All gates pass against an LF working tree.** Every one of the 242 tracked files was
  converted to LF, making the working tree byte-identical to what Linux checks out, and then
  `npx tsc --noEmit`, `npm test` (192 tests at the time), `npm run check-leaks`, `npm run demo`
  and `npm run verify-fixtures` (27 fixtures, 7 of them controls) were all run green against it.
  This is the strongest available local proxy: it removes line endings as a variable entirely.
  Re-run on Windows after the audit fixes and after the Google adapter was removed (MVP scope:
  OpenAI only), against the same LF-pinned tree and now six gates: `npm test` **141 tests**
  (184 before the removal took three adapter test files with it), `npm run verify-fixtures`
  **30 fixtures — 23 solvable, 7 controls, and 8 hard-tier naive fixes each required to stay
  red**, and `npm run evidence` recomputing 121 runs / $0.3529 from the tracked databases. The
  older counts are left above rather than overwritten, because that bullet records a run that
  happened. One platform note went with the adapter: `GEMINI_MIN_INTERVAL_MS` no longer exists,
  so the only environment variable any command reads is `OPENAI_API_KEY`, and no gate reads it.
- **Static audits.** No `shell: true` anywhere at all; exactly one `process.platform`
  branch in the whole repo, the drive-letter case in `src/tools.test.ts` that asserts
  rejection on win32 and acceptance on POSIX (see the matrix findings below) — every
  other check is written to be platform-blind rather than platform-branched; every
  relative import resolves to an
  on-disk filename with exactly matching case; every path handed outward is separator-
  normalised.
- **The leak guard still fires** after being made platform-stable, re-checked by planting a
  probe and observing exit 1 with a forward-slashed path.

## Verified on all three platforms

`.github/workflows/gates.yml` run **32122510801** on `feat/agent-eval-harness`:

| Job | npm ci | tsc | test | check-leaks | demo | verify-fixtures |
|---|---|---|---|---|---|---|
| ubuntu-latest, Node 22 | ok | ok | ok | ok | ok | ok |
| ubuntu-latest, Node 26 | ok | ok | ok | ok | ok | ok |
| macos-latest, Node 22 | ok | ok | ok | ok | ok | ok |
| windows-latest, Node 22 | ok | ok | ok | ok | ok | ok |

All six steps green on every job — and zero annotations, because `checkout` and
`setup-node` are on v7 rather than a runtime the runners have deprecated. That
includes `verify-fixtures`, which reported
"all fixtures fail before and pass after, and all 7 control fixture(s) stay red" on
each. That also settles the two things flagged as untestable locally:
`better-sqlite3` builds and loads on all three runner images, and the tsconfig casing
guard held.

Local runs show a higher test count than CI (193 vs ubuntu's 175) for a mundane
reason worth writing down so nobody chases it: the working tree carries an unrelated
in-flight feature whose tests are not committed. CI runs the committed tree.

### What the matrix caught that local work could not

Two real defects, neither of which the LF-equivalence run or the static audits could
have found:

1. **A test that encoded the platform instead of the property.** `resolveInRoot` was
   asserted to reject `C:\Windows\System32\config`. On POSIX a drive letter means
   nothing and a backslash is a legal filename character, so that string is a
   *relative* name resolving inside root — and accepting it is correct. Windows passed,
   ubuntu and macOS failed. The case is now split: escapes-everywhere in the shared
   table, a genuinely-absolute sibling of root built from `os.tmpdir()`, and the
   drive-letter case asserting rejection on win32 and acceptance on POSIX.
2. **A test committed without its implementation.** Staging `src/tools.test.ts`
   wholesale swept in an uncommitted symlink-escape test while the `realpath` guard it
   exercises stayed unstaged. The committed tree therefore tested a feature it did not
   contain, and CI went red on all three platforms while the identical suite passed
   locally. `git add <file>` stages the file, not the hunks you had in mind — in a tree
   holding someone else's work in progress, that is how a pair gets separated.

Both are the kind of failure that is invisible until something actually runs the code
somewhere else, which is the argument for the matrix existing at all.

## Standing limitation

CI proves the committed tree on the three GitHub runner images, on Node 22 everywhere and
Node 26 on Linux. Node 26 on **Windows** is covered locally rather than in CI: all five
gates were run green on v26.3.0 on the development machine, which is the same platform the
matrix already covers on 22 — so no OS is left with only one Node major behind it.

What it still says nothing about: other libc implementations (Alpine/musl), other
architectures (arm64 Linux), and Node majors between 22 and 26. Those stay out of scope
deliberately — the question this answers is "does this work off Windows, on the Node
versions package.json promises", not "does this work everywhere".
