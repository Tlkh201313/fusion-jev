# Raw vs Fusion on real commands (2026-10-03, re-run on current code)

**What this measures:** the bytes (and estimated tokens) of command output a host would receive when it runs a command natively versus through `fusion-jev run`, plus wall-clock time, exit-code preservation, whether the key failure line is visible, and whether the original bytes come back (from `fusion-jev evidence ID --raw` for receipts, or directly for output Fusion now passes through verbatim).

**What this does not measure:** host end-to-end token usage, bills or task quality. For that, see the separate Claude Code A/B in [`2026-10-03-real-host-claude.md`](2026-10-03-real-host-claude.md).

This is a re-run of [`2026-10-02-raw-vs-fusion.md`](2026-10-02-raw-vs-fusion.md) after the output-format change: small complete output (≤ 1 KiB, UTF-8, unredacted) is printed verbatim plus one `exitCode=N durationMs=N` line and no receipt; larger output keeps a compact receipt (status line, diagnostics, `omittedBytes`, one `recoverStdout=` line per stored channel).

Raw data: [`2026-10-03-raw-vs-fusion.json`](2026-10-03-raw-vs-fusion.json) (exact Fusion output per case, all per-run timings), [`2026-10-03-raw-vs-fusion.csv`](2026-10-03-raw-vs-fusion.csv). Script: [`../raw-vs-fusion.mjs`](../raw-vs-fusion.mjs). Local paths in the published files are replaced with `<scratch>`.

## Environment

| | |
| --- | --- |
| OS / CPU | Windows 11 Home 10.0.26100, Intel Core i7-14700HX (28 logical CPUs) |
| Load | **The machine was busy.** An unrelated long-running `find` process was using CPU throughout, and total CPU load was 57% at the start (48-57% during the later runs). Raw and Fusion runs were alternated per iteration, so both saw the same load. Absolute times are **not** comparable with 2026-10-02: native commands were 1.3-3x slower today too (for example `npm run typecheck` 1.9 s → 5.1 s, `node --test` setup file 18 s → 55 s). |
| Node | v24.12.0 |
| fusion-jev | 0.3.0, local build (`node dist/cli.js`) |
| Commit | `fc9421970171a0e430b13f501f1e9d09c4dc7488` (previous run: `1677e6d`) |
| Runs | 5 per case (previous: 3), raw/Fusion order alternated; time = median |
| Tokenizer | bytes/4, and `gpt-tokenizer` `o200k_base` (an OpenAI encoding used only as a proxy, **not** Claude's tokenizer) |

## Before / after

Bytes and tokens are stdout+stderr of the first run. Raw bytes for the `git` cases grew because the repository has more history at the new commit (for example `git log -50` 7,583 → 8,996 bytes). Time is median native / median Fusion in ms.

| Case | Raw bytes (now) | Fusion bytes before → now | Fusion o200k tokens before → now (raw now) | Time raw/Fusion before → now (ms) | Error kept before → now | Restore before → now |
| --- | ---: | ---: | ---: | ---: | :---: | --- |
| `npm run typecheck` (passes) | 60 | 1,042 → **87** | 369 → **34** (24) | 1,883/2,962 → 5,123/5,458 | n/a | receipt Y → verbatim, exact |
| `tsc -p .`, 3 errors | 287 | 1,385 → **313** | 508 → **97** (88) | 661/2,461 → 876/1,126 | Y → Y | receipt Y → verbatim, exact |
| `tsc -p .`, 60 errors | 4,995 | 1,473 → **711** | 542 → **301** (1,620) | 768/2,437 → 861/5,089 | Y (4 of 60) → Y (4 of 60) | receipt Y → receipt Y |
| `npx tsx --test test/setup.test.ts` (7 pass) | 700 | 1,683 → **728** | 542 → **204** (194) | 18,359/20,145 → 54,831/57,694 | n/a | timings differ¹ → verbatim, timings differ¹ |
| `node --test`, 1 of 61 fails | 2,611 | 988 → **459** | 351 → **176** (1,028) | 200/1,382 → 796/4,698 | **N → Y** | timings differ¹ → timings differ¹ |
| `git log -50` | 8,996 | 988 → **205** | 365 → **81** (2,571) | 76/1,242 → 194/2,963 | n/a | Y → Y |
| `git log -p -n 20` | 1,277,810 | 1,681 → **259** | 613 → **102** (352,840) | 178/1,190 → 255/3,807 | n/a | N (redacted²) → N (redacted²) |
| `git diff HEAD~3 --stat` | 2,190 | 988 → **205** | 362 → **91** (500) | 133/1,664 → 191/3,522 | n/a | Y → Y |
| README 200-line noise fixture | 4,341 | 1,078 → **321** | 400 → **135** (1,216) | 70/1,197 → 229/3,647 | Y → Y | Y → Y |
| `node --version` | 10 | 990 → **36** | 375 → **16** (7) | 54/1,215 → 141/492 | n/a | Y → verbatim, exact |
| `git status --short -- src` (empty) | 0 | 978 → **26** | 345 → **9** (0) | 72/1,367 → 220/559 | n/a | Y → verbatim, exact |
| **Sum, all 11 cases** | 1,302,000 | 13,274 → **3,350** | 4,772 → **1,246** (360,088) | | | |
| **Sum without `git log -p`** | 24,190 | 11,593 → **3,091** | 4,159 → **1,144** (7,248) | | | |

Exit codes were preserved in all 55 run pairs (11 cases × 5).

¹ Test runners print per-test durations, so two executions never match byte for byte. For the receipt case the recovered byte count equals Fusion's own `stdoutStoredBytes`, and the recovered output equals the native run once durations are normalised. The passing setup test is now shown verbatim; it differs from the adjacent native run only in its durations.

² `git log -p` matched the secret-pattern redaction (`stdoutRedacted=true`, 1,277,810 original → 1,277,798 stored bytes). Recovery returns the redacted copy by design.

## Findings

1. **The fixed ~1 KB overhead is gone.** Output that fits under 1 KiB is now passed through verbatim with a single status line: +9 to +36 bytes (+2 to +10 o200k tokens) instead of +950 to +1,100 bytes. In the previous run 5 of 11 cases got larger through Fusion by 141% to 9,800%. Now those 5 cases are 4-45% larger in bytes, which is a few tokens each. For `git status` with empty output, the host now gets 26 bytes (`exitCode=0 durationMs=...`) instead of 978.
2. **Receipts are smaller.** A content-free receipt (no diagnostics) is 4.8-6.5x smaller: it is now ~205-260 bytes (~80-100 o200k tokens) instead of ~990-1,680 bytes, because the recovery block is a single relative command line with no absolute paths. Across all 11 cases the host-visible Fusion output dropped from 4,772 to 1,246 o200k tokens (−74%).
3. **The `node --test` failure is now surfaced.** The compact output names the failing test, file:line:col and the assertion (`sum handles negative offset: AssertionError ... 1 !== 3`) in 459 bytes, so the host no longer has to expand the receipt for this case. (The diagnostic line carries the absolute path of the test file. In the published JSON it is replaced by `<scratch>`.)
4. **No false-positive diagnostics on `git log -p`.** The four spurious `error:` diagnostics from old diff content are gone. The compact output contains only the status line, `omittedBytes` and the recovery line.
5. **Unchanged caveat for informational commands.** `git log`, `git log -p` and `git diff --stat` still show **no content**, only a receipt. A host that needs the content has to expand it, which costs roughly the raw bytes again. The reduction column is not a saving for those workloads unless the host never reads the content.
6. **tsc errors are still capped at 4 shown** (`diagnosticsOmitted=56` for the 60-error case).
7. **Latency is split by path, and the receipt path did not get faster.** Median Fusion-minus-native overhead under today's load:
   - **Verbatim path** (no store write): +250 to +350 ms (`node --version` +351, empty `git status` +339, small tsc +250, passing typecheck +335). Before: +1.1 to +1.8 s. This is a clear improvement.
   - **Receipt path** (evidence written to the store): +2.8 to +4.2 s (`git log -50` +2.8 s, `git diff --stat` +3.3 s, README fixture +3.4 s, `git log -p` +3.6 s, failing `node --test` +3.9 s, 60-error tsc +4.2 s). Before: +1.0 to +1.8 s.
   - Because native commands were also 1.3-3x slower today, part of this is machine load. But the verbatim path was measured under the same load and costs only ~0.3 s, so roughly **2.5-3.5 s per call goes to the store-write path on this machine today**. That is worse than the ~1.1-1.8 s total overhead measured yesterday. Commits after `1677e6d` harden the Windows private evidence cache, which is a plausible cause. This was **not profiled**: re-measure on an idle machine before drawing a conclusion.
8. **Restore:** byte-identical for all 4 receipt cases with deterministic output. Verbatim passthrough is byte-identical for the 4 deterministic small cases. The two test-runner cases differ only in timings, and `git log -p` is redacted and flagged.

## Method

- Command: `node benchmark/raw-vs-fusion.mjs --runs=5 --out=<scratch>/2026-10-03-raw-vs-fusion --tokenizer=<dir with gpt-tokenizer>`. JSON/CSV were then copied here with local paths replaced.
- The cases, scratch fixtures and comparison logic are the same as in the 2026-10-02 run (see that file's Method section). The script's parser handles both output shapes: verbatim plus status line, or `termination=...` receipt.
- Timing is wall clock around each spawned process, including Node/CLI startup. No warm-up was discarded.

## Limits

- One machine, Windows only, **under heavy unrelated CPU load**. Timings are indicative only. Bytes and tokens do not depend on load.
- Tool-output bytes only. o200k is a proxy tokenizer.
- Before/after compares two commits with different repository history, so raw sizes for `git` cases differ slightly.
- The short recovery line (`recoverStdout=fusion-jev evidence <id> --raw`) depends on a `fusion-jev` binary being on PATH, which was true here (global npm install). Without one, `src/cli.ts` prints `recoverStdoutArgv=[<node>, <absolute path to cli.js>, ...]` instead. That adds roughly 100-250 bytes per stored channel, depending on install path. `test/run-compact.test.ts` (its `< 500` bytes assertion) fails in that situation when the checkout path is long; this was observed in the real-host A/B.
