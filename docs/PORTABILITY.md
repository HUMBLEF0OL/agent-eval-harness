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
| `* text=auto eol=lf` | `.gitattributes` | every checkout is LF, so fixture bytes and their hashes are identical on all three platforms — including on Windows, where `core.autocrlf=true` would otherwise win |
| No `shell: true` anywhere | `src/sandbox.ts`, `scripts/verify-fixtures.mjs`, `src/report.test.ts` | `process.execPath` runs the tool's own CLI entry directly. No `cmd.exe`/`/bin/sh` re-parsing, so arguments need no hand-quoting, paths with spaces work unchanged, and a timeout signals the real process instead of a shell that leaves the grandchild orphaned |
| `.split(path.sep).join("/")` | `tools.ts`, `score/tamper.ts`, `runner.ts`, `verify-fixtures.mjs` | every path the model or the database ever sees is forward-slashed, so trajectories and `tamperDetail` are comparable across platforms |
| `forceConsistentCasingInFileNames` | `tsconfig.json` | Windows and macOS resolve imports case-insensitively, Linux does not. Set explicitly so a mismatch fails here rather than only in CI |
| Platform-stable output | `scripts/check-leaks.mjs` | the "allowed directory" string is a literal `src/provider`, not `path.join(...)`, which used to print `src\provider/` on Windows and `src/provider/` on Linux |
| Sandboxes under `<repo>/.aeh-tmp/` | `src/sandbox.ts` | a Windows constraint kept deliberately: Node's ESM resolver will not cross drive letters, and `os.tmpdir()` is on `C:` while a repo may be on `E:`. Harmless on POSIX, where it is simply a directory — but the *reason* is Windows-only, and it is written down so nobody "simplifies" it back to `os.tmpdir()` |
| Matrix CI | `.github/workflows/gates.yml` | runs the five zero-cost gates on `ubuntu-latest`, `windows-latest` and `macos-latest`, `fail-fast: false` so a red Linux does not hide the macOS answer |

## What has been verified, and how

Verified locally, on Windows:

- **All five gates pass against an LF working tree.** Every one of the 242 tracked files was
  converted to LF, making the working tree byte-identical to what Linux checks out, and then
  `npx tsc --noEmit`, `npm test` (192 tests), `npm run check-leaks`, `npm run demo` and
  `npm run verify-fixtures` (27 fixtures, 7 of them controls) were all run green against it.
  This is the strongest available local proxy: it removes line endings as a variable entirely.
- **Static audits.** No `shell: true` outside of nothing at all; no `process.platform` or
  `win32` branch anywhere in `src/` or `scripts/`; every relative import resolves to an
  on-disk filename with exactly matching case; every path handed outward is separator-
  normalised.
- **The leak guard still fires** after being made platform-stable, re-checked by planting a
  probe and observing exit 1 with a forward-slashed path.

## What has NOT been verified

**The suite has never executed on Linux or macOS.** No WSL is available on the development
machine, so there is no local POSIX runtime to run it in. The LF-equivalence run above removes
line endings from the equation and the audits remove the patterns that usually break, but
neither is the same as a green Linux run.

`.github/workflows/gates.yml` is the mechanism that closes this, and **it proves nothing until
the branch is pushed** — a workflow file in an unpushed branch has never run. Until then, the
correct summary is: *portable by construction and by audit, unproven by execution.*

Two specific things CI is expected to catch that local work cannot:

- `better-sqlite3` is a native module and is rebuilt per platform by `npm ci`. It compiles on
  all three in principle; whether it does on these runner images is untested here.
- Case-sensitivity regressions in future edits, which is exactly why the tsconfig flag is
  explicit rather than left to the TypeScript 5 default.
