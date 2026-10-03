# Raw vs Fusion on real commands (2026-10-02)

**What this measures:** the bytes (and estimated tokens) of command output a host would receive when it runs a command natively versus through `fusion-jev run`, plus wall-clock time, exit-code preservation, whether the key failure line is visible in the compact output, and whether `fusion-jev evidence ID --raw` restores the original bytes.

**What this does not measure:** real host end-to-end token usage, bills, subscription usage, or task quality/success. No host (Claude Code, Codex) was in the loop, so the [real-host table](../real-host.md) is still `TBD`. Do not read the reduction column as a cost saving: for several cases the host would have to expand a receipt to do its job, which costs the raw bytes again plus overhead.

Raw data: [`2026-10-02-raw-vs-fusion.json`](2026-10-02-raw-vs-fusion.json) (includes the exact Fusion output for each case and per-run timings), [`2026-10-02-raw-vs-fusion.csv`](2026-10-02-raw-vs-fusion.csv). Script: [`../raw-vs-fusion.mjs`](../raw-vs-fusion.mjs).

## Environment

| | |
| --- | --- |
| OS | Windows 11 Home 10.0.26100 (win32) |
| Node | v24.12.0 |
| fusion-jev | 0.3.0, local build (`npm run build`, `node dist/cli.js`) |
| Commit | `1677e6df0dd39ba500dfed37299c7ca961a9538f` |
| Runs | 3 per case, raw/Fusion order alternated per run; time = median |
| Tokenizer | bytes/4 estimate, and `gpt-tokenizer` 3.4.0 `o200k_base` (an OpenAI encoding, used only as a proxy; it is **not** Claude's tokenizer) |

## Results

Bytes are stdout+stderr of the first run. "Reduction" is `1 - fusion/raw`; negative means Fusion output is larger. "Error kept" = the case's key failure text appears in the compact output (n/a for passing/informational commands). "Restore identical" = SHA-256 of `evidence --raw` for both channels equals the adjacent native run.

| Case | Raw bytes | Fusion bytes | Reduction | Tokens raw / Fusion (bytes/4) | Tokens raw / Fusion (o200k) | Time raw / Fusion (ms, median) | Exit kept | Error kept | Restore identical |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | :---: | :---: |
| `npm run typecheck` (passes) | 60 | 1,042 | **-1,637%** | 15 / 261 | 24 / 369 | 1,883 / 2,962 | Y | n/a | Y |
| `tsc -p .`, 3 errors (scratch) | 287 | 1,385 | **-383%** | 72 / 347 | 88 / 508 | 661 / 2,461 | Y | Y | Y |
| `tsc -p .`, 60 errors (scratch) | 4,995 | 1,473 | 70.5% | 1,249 / 369 | 1,620 / 542 | 768 / 2,437 | Y | Y (4 of 60 shown) | Y |
| `npx tsx --test test/setup.test.ts` (7 pass) | 698 | 1,683 | **-141%** | 175 / 421 | 195 / 542 | 18,359 / 20,145 | Y | n/a | timings differ¹ |
| `node --test`, 1 of 61 fails (scratch) | 2,604 | 988 | 62.1% | 651 / 247 | 1,021 / 351 | 200 / 1,382 | Y | **N** | timings differ¹ |
| `git log -50` | 7,583 | 988 | 87.0%² | 1,896 / 247 | 2,194 / 365 | 76 / 1,242 | Y | n/a | Y |
| `git log -p -n 20` | 1,112,270 | 1,681 | 99.8%² | 278,068 / 421 | 304,090 / 613 | 178 / 1,190 | Y | n/a | **N** (redacted³) |
| `git diff HEAD~3 --stat` | 1,323 | 988 | 25.3%² | 331 / 247 | 277 / 362 | 133 / 1,664 | Y | n/a | Y |
| README 200-line noise fixture | 4,341 | 1,078 | 75.2% | 1,086 / 270 | 1,216 / 400 | 70 / 1,197 | Y | Y | Y |
| `node --version` | 10 | 990 | **-9,800%** | 3 / 248 | 7 / 375 | 54 / 1,215 | Y | n/a | Y |
| `git status --short -- src` (empty) | 0 | 978 | n/a (raw empty) | 0 / 245 | 0 / 345 | 72 / 1,367 | Y | n/a | Y |

¹ Test runners print per-test durations, so two executions never match byte for byte. For these cases the recovered byte count equals the `stdoutOriginalBytes` Fusion reported for its own run, and recovered output equals the native run once durations are normalised. That is evidence of faithful capture, not a same-run byte comparison.

² For informational commands the compact output contains **no content** (only the receipt header, `omittedBytes=N`, and recovery lines). The host cannot answer "what changed in the last 50 commits" from it; it must expand the receipt, paying roughly the raw bytes plus Fusion's overhead. The reduction column is therefore not a saving for these workloads unless the host never needs the content.

³ Fusion flagged `stdoutRedacted=true` (12 bytes removed by secret-pattern redaction: 1,112,270 original, 1,112,258 stored). Recovery returns the redacted copy, as documented. Byte-identical restore is not possible in that case by design.

## Findings

1. **Fixed overhead is about 1 KB per call.** Even an empty result produces ~980 bytes (~245 bytes/4 tokens, ~345-375 o200k tokens): the status header line plus four recovery lines, two of which contain absolute paths. Any output under roughly 1 KB gets larger through Fusion. In this sample that was 5 of 11 cases (passing typecheck, small tsc failure, passing test file, `node --version`, empty `git status`).
2. **Big noisy output shrinks a lot.** 60-error tsc (-70%), README noise fixture (-75%), failing `node --test` (-62%), `git log -p` (-99.8%).
3. **The `node --test` failure was not surfaced.** Node 24's default spec reporter output (`✖ sum handles negative offset`, `AssertionError ... Expected values to be strictly equal`) produced zero diagnostics in the compact output. The host sees `exitCode=1` and `omittedBytes=2607` and must expand the receipt to learn which test failed. The offline support fixture uses TAP `not ok`, which is why the offline benchmarks do not catch this.
4. **False-positive diagnostics on Git history.** `git log -p` (exit 0) produced four "diagnostics": lines in old diffs of this repo's own fixtures and SVG that contain `error:`. A host could mistake these for current failures.
5. **tsc errors are capped.** For 60 identical errors the compact output shows 4 and reports `diagnosticsOmitted=56`. Fine for this repetitive case. With varied errors the host may need to expand.
6. **Exit codes were preserved in every case** (33 of 33 run pairs).
7. **Latency: Fusion adds about 1.1-1.8 s per call on this machine** (median overhead: ~1.1 s for `git log`/`node --version`, ~1.7-1.8 s for tsc, ~1.1 s for typecheck). For fast commands this is a 10-22x slowdown. For the 18 s test run it is within run-to-run noise. The cost looks like CLI startup plus evidence-store initialisation on Windows (the offline support benchmark reports `windowsPrivateCacheStartupMs` ≈ 765 ms). It was not profiled further. Speed was not measured on Linux or macOS, or via the long-lived MCP server, where store startup may be amortised.
8. **Restore:** byte-identical for 8 of 11. The other three: two only differ because of test timings (byte count matches Fusion's own capture), and one was redacted and flagged as such.

## Method

- Script: `node benchmark/raw-vs-fusion.mjs --runs=3 --out=benchmark/results/2026-10-02-raw-vs-fusion --tokenizer=<dir with gpt-tokenizer installed>`. Omit `--tokenizer` to skip the o200k counts.
- Native: `cross-spawn` sync with the same argv and cwd. Captured stdout and stderr as buffers.
- Fusion: `node dist/cli.js run --cwd=<cwd> -- <argv>`. Host-visible bytes = the CLI's stdout+stderr, which is everything a host shell tool would return (summary, receipt IDs, recovery lines).
- Restore: after the first Fusion run of each case, `node dist/cli.js evidence <stdoutId> --raw` and `<stderrId> --raw`, SHA-256 compared with the native run of the same iteration.
- Scratch fixtures (generated into a temp directory and deleted afterwards): a 21-file strict TS project with 3 errors, a 12-file project with 60 errors (both checked with this repo's `typescript` 7.0.2 `tsc`), and a `node:test` file with 60 passing and 1 failing test.
- Repo commands ran against this checkout at the commit above. `git log` output therefore depends on repository history.
- Timing: wall clock around each spawned process, including Node/CLI startup, which is the real cost a host pays per call. No warm-up was discarded.

## Limits of this benchmark

- One machine, one OS (Windows), one run of 3 iterations. No variance claims beyond the per-run timings in the JSON.
- Tool-output bytes only. Hosts wrap tool results differently, may apply their own truncation, and the token count that matters is the host model's, not o200k.
- No task-quality measurement: whether a host can fix the failure from the compact output without expanding is not measured here (finding 3 suggests it often cannot for `node --test`).
- Offline fixture benchmarks (`npm run benchmark*`) measure different things; see their outputs alongside this file (`2026-10-02-offline-*.json`). On this date `npm run benchmark:overview` **failed**: its assertion `/src\/cli.ts ->/` no longer matches because the dependency section is output-limited after `src/index.ts` (log in `2026-10-02-offline-benchmark-overview.FAILED.txt`).
