# Real host A/B: Claude Code with and without Fusion (2026-10-03)

**What this measures:** whole Claude Code sessions (`claude -p`, headless) doing three small tasks on this repository, once with no Fusion and once with Fusion. Per run it records the host-reported usage (input, cache read, cache write and output tokens), `total_cost_usd`, `duration_ms`, turns, which tools were called, and whether the answer was correct. Answers are graded automatically against a planted, known answer.

**What it is not:** a general claim. There are 2 repetitions per task and arm (12 runs), one model, one machine under heavy unrelated load, and three tasks whose command output is small. Differences smaller than the run-to-run spread inside one arm are noise.

Raw data: [`2026-10-03-real-host-claude.json`](2026-10-03-real-host-claude.json) (per-run rows with tool sequence and final answer, exact flags, prompts, plants, graders). Local paths are replaced with `<repo>`, `<worktree>`, `<scratch>` and `<home>`.

## Setup

| | |
| --- | --- |
| Host | Claude Code CLI 2.1.288, headless `claude -p`, `--output-format stream-json --verbose` |
| Model | `--model sonnet` (resolved to `claude-sonnet-5-5`) |
| OS / CPU | Windows 11 Home 10.0.26100, i7-14700HX (28 logical CPUs). **Busy machine:** an unrelated CPU-heavy process ran throughout. CPU load before each run was 0-53% (per-run value in the JSON). |
| Repo | commit `fc94219`, fusion-jev 0.3.0 local build (`dist/cli.js`) |
| Isolation | Each run used a fresh `git worktree add --detach <scratch>/wt-<run> HEAD`, with `node_modules` junctioned from the main checkout. The worktree was removed afterwards. |
| Order | Per task: baseline r1, fusion r1, fusion r2, baseline r2, run sequentially |
| Budget guard | `--max-budget-usd 0.40` per run, `--max-turns 15`. No run came close to the cap. |

### Flags and environment (both arms)

```
claude -p "<task prompt>" --model sonnet --output-format stream-json --verbose \
  --max-budget-usd 0.40 --max-turns 15 --permission-mode bypassPermissions --no-session-persistence \
  --strict-mcp-config --setting-sources project \
  --settings '{"enabledPlugins":{"fusion-jev@fusion-jev":false,"cc-plugin-agents-md@builtin":false}}' \
  --mcp-config <per-arm json>
env: CLAUDE_CODE_DISABLE_CLAUDE_MDS=1
     CLAUDE_ENV_FILE=<scratch>/env-<arm>.sh   # sourced before every Bash tool command
     PATH = process PATH without the npm global bin (where fusion-jev is installed globally)
```

- **Baseline:** `--mcp-config` is `{"mcpServers":{}}` and there is no appended prompt. The env file strips the npm global bin from the Bash tool's PATH. Verified in a probe: `which fusion-jev` finds nothing in Bash, and `Get-Command fusion-jev` finds nothing in PowerShell.
- **Fusion:** `--mcp-config` adds `{"fusion":{"command":"node","args":["<repo>/dist/cli.js","stdio"],"env":{"FUSION_WORKSPACE_ROOT":"<worktree>"}}}`. `--append-system-prompt` is the plugin's SessionStart text (output of `plugin/fusion-jev-claude/scripts/session-start.cjs`) plus one sentence saying `fusion-jev` is on PATH. A shim `<scratch>/bin/fusion-jev{,.cmd,.ps1}` runs `node <repo>/dist/cli.js` and is first on PATH, both in the process env and in the env file. Verified in a probe: Bash resolves the shim, and `fusion-jev run -- node --version` printed the new verbatim format.
- **What was neutralised, equally for both arms:** user CLAUDE.md, imported FUSION.md and the parent-directory AGENTS.md (`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` plus disabling the builtin agents-md plugin), user plugins, skills, hooks and MCP servers (`--setting-sources project`, `--strict-mcp-config`). Probes confirmed that neither arm saw graphify, gstack, ruflo, FUSION.md or caveman text, and that the baseline saw no Fusion text other than the repository's own git commit messages.
- **Isolation methods rejected:**
  - `--safe-mode` also drops `--mcp-config` servers, so the Fusion arm got no MCP tools.
  - `--bare` requires an API key and does not use OAuth.
  - `CLAUDE_CONFIG_DIR` was not needed.
- **Remaining asymmetry, by design:** the Fusion arm's system prompt is ~420 tokens longer per API call (appended hint, MCP server instructions, three deferred tool names). That is the cost of having Fusion installed and is included in its numbers.

### Tasks and graders

| # | Plant | Prompt | Known answer | Grader |
| --- | --- | --- | --- | --- |
| 1 | append `export const plantedTypeError: string = 42;` to `src/overview.ts` | "Run the TypeScript typecheck (npm run typecheck) and tell me the file, line and error code of every type error. Do not fix anything." | `src/overview.ts` line 165, TS2322 | contains `overview.ts`, `165`, `TS2322` |
| 2 | `test/diagnostics-parsing.test.ts:68`: expected line `3` → `4` | "Run `npx tsx --import ./test/offline-env.ts --test test/diagnostics-parsing.test.ts test/overview-entry-points.test.ts test/run-compact.test.ts test/setup.test.ts` and tell me exactly which test fails and why. Do not fix anything." | "node:test spec location falls back to the "test at" line when no file frame exists": expected 4, actual 3 | names that test and mentions 3 and 4 |
| 3 | none | "Using git, which commit (short sha) first added the file docs/assets/hero.svg, and how many files did that commit change?" | `1677e6d`, 7 files | contains `1677e6d` and 7 |

## Results

### Medians per task and arm (n = 2 each)

"Input-side tokens" = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from the host's `result` event. "Tool-result chars" = total characters of tool results returned to the model in the session.

| Task | Arm | Correct | Input-side tokens | Cache read | Cache write | Output | Cost (USD) | Duration (s) | Turns | Tool-result chars | Used Fusion |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 1 typecheck | baseline | 2/2 | 69,099 | 63,362 | 5,733 | 171 | 0.0373 | 48.2 | 2 | 159 | 0/2 |
| 1 typecheck | fusion | 2/2 | 70,289 | 64,205 | 6,081 | 177 | 0.0389 | 93.9 | 2 | 188 | 2/2 |
| 2 failing test | baseline | 2/2 | 111,138 | 100,311 | 10,821 | 1,240 | 0.0758 | 105.8 | 3.5 | 9,921 | 0/2 |
| 2 failing test | fusion | 2/2 | 126,609 | 117,733 | 8,869 | 776 | 0.0668 | 124.9 | 3.5 | 5,326 | 2/2 |
| 3 git history | baseline | 2/2 | 86,452 | 80,637 | 5,811 | 219 | 0.0416 | 110.1 | 2.5 | 169 | 0/2 |
| 3 git history | fusion | 2/2 | 70,192 | 64,191 | 5,997 | 191 | 0.0387 | 90.4 | 2 | 9 | 0/2 |

### Per run

| Task | Arm | Rep | Correct | Input | Cache read | Cache write | Output | Cost (USD) | Duration (s) | Turns | Tool calls | Fusion calls | Tool-result chars | CPU load before |
| --- | --- | ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | baseline | 1 | Y | 4 | 63,363 | 5,735 | 172 | 0.0373 | 50.6 | 2 | 1 | 0 | 159 | 35% |
| 1 | baseline | 2 | Y | 4 | 63,361 | 5,730 | 169 | 0.0373 | 45.8 | 2 | 1 | 0 | 159 | 25% |
| 1 | fusion | 1 | Y | 4 | 64,203 | 6,082 | 177 | 0.0389 | 110.1 | 2 | 1 | 1 | 188 | 27% |
| 1 | fusion | 2 | Y | 4 | 64,206 | 6,079 | 176 | 0.0389 | 77.7 | 2 | 1 | 1 | 188 | 14% |
| 2 | baseline | 1 | Y | 6 | 100,304 | 10,159 | 978 | 0.0705 | 156.1 | 3 | 2 | 0 | 8,956 | 0% |
| 2 | baseline | 2 | Y | 6 | 100,318 | 11,483 | 1,502 | 0.0810 | 55.6 | 4 | 3 | 0 | 10,885 | 2% |
| 2 | fusion | 1 | Y | 8 | 135,564 | 8,341 | 846 | 0.0690 | 94.1 | 4 | 3 | 3 | 3,970 | 3% |
| 2 | fusion | 2 | Y | 6 | 99,902 | 9,396 | 706 | 0.0646 | 155.8 | 3 | 2 | 2 | 6,682 | 16% |
| 3 | baseline | 1 | Y | 6 | 97,923 | 5,792 | 225 | 0.0450 | 70.6 | 3 | 2 | 0 | 58 | 43% |
| 3 | baseline | 2 | Y | 4 | 63,350 | 5,829 | 212 | 0.0381 | 149.5 | 2 | 1 | 0 | 279 | 53% |
| 3 | fusion | 1 | Y | 4 | 64,190 | 6,003 | 211 | 0.0390 | 67.2 | 2 | 1 | 0 | 9 | 7% |
| 3 | fusion | 2 | Y | 4 | 64,191 | 5,991 | 170 | 0.0385 | 113.7 | 2 | 1 | 0 | 9 | 28% |

**Spend:** $0.598 for the 12 reported runs. Including isolation probes ($0.398) and a discarded first pass ($0.392, see Caveats), the total reported by the host was **$1.388**. One aborted run's cost is not included (it was killed before reporting a result).

## Findings

1. **All 12 answers were correct.** Fusion neither helped nor hurt correctness on these tasks.
2. **Task 1 (typecheck, small output): Fusion costs slightly more.** The output is 149 bytes, so `fusion-jev run` passed it through verbatim plus `exitCode=1 durationMs=N` (188 vs 159 tool-result chars). The session cost +$0.0016 (+4%) and +1,190 input-side tokens. That difference is the Fusion arm's longer system prompt (~420 tokens per call) plus the status line. Cost was nearly identical within each arm (±$0.0001), so this difference is real, but small.
3. **Task 2 (failing test among 22): the Fusion arm returned 46% fewer tool-result chars and cost 12% less (median), but it used more input-side tokens (+14%).** In both Fusion runs the compact receipt named the failing test, file:line and assertion in ~645 chars. The model still expanded the receipt (`fusion-jev evidence <id> --raw`, 2/2) to read the full assertion diff, then read the test source. One Fusion run first passed an unquoted `--` in PowerShell (`Usage:` error) and retried with `'--'`, which added a turn. **This comparison is confounded** (next item), so do not read the 12% as Fusion's saving.
4. **Task 2 exposed an environment-dependent test, and the arms did not see the same failures.** `test/run-compact.test.ts:67` asserts that compact output is under 500 bytes. `src/cli.ts` prints the short `recoverStdout=fusion-jev evidence <id> --raw` line only when a `fusion-jev` binary is on PATH; otherwise it prints `recoverStdoutArgv=[<node.exe>, <abs path>/src/cli.ts, ...]`, which under a long checkout path pushes the output past 500 bytes. With no `fusion-jev` on PATH (the baseline), the test **really fails**. Both baseline runs correctly reported 2 failures and spent extra turns and tokens diagnosing the second one. With the shim on PATH (the Fusion arm), only the planted test failed. The baseline therefore had more work to do on task 2.
5. **Task 3 (git history): Fusion was available but not used (0/2).** The model answered with two tiny `git` commands in both arms. The baseline's higher median ($0.0416 vs $0.0387) comes from one baseline run taking an extra turn. That is the run-to-run noise floor for these sessions: about ±$0.005 and ±30k input-side tokens from one extra turn.
6. **MCP tools were never called.** In every Fusion run the model used the `fusion-jev run` / `fusion-jev evidence` CLI through Bash or PowerShell. It never loaded `fusion_inspect`, `fusion_evidence` or `fusion_assist`, so their cost was only the ~420 tokens of instructions and names per call.
7. **Duration is not comparable here.** Wall time was dominated by machine load and by how long the test suite took in that run (for example the same typecheck took 17-36 s inside Fusion and ~45-50 s for whole baseline sessions). No speed conclusion should be drawn from this table. The host-less benchmark ([`2026-10-03-raw-vs-fusion.md`](2026-10-03-raw-vs-fusion.md)) measured +0.25-0.35 s per verbatim call and +2.8-4.2 s per receipt call under the same load.

## Caveats

- **n = 2 per cell, one model, one machine under heavy and varying load.** Medians of two values are their mean. This is a smoke test of real host behaviour, not a statistically supported saving or cost claim.
- **The tasks have small outputs** (typecheck 149 bytes, test run ~3.3 KB, git ~60-280 chars). Fusion's compaction matters most for large noisy output, which these tasks barely exercise. A task with tens of KB of output would be a better test of the savings claim.
- **Discarded first pass.** A first pass of 7 completed runs (+1 aborted) was thrown away. Claude Code's Bash tool starts a login shell that rebuilds PATH from the Windows user profile, so the globally installed `fusion-jev` (an older npm build of 0.3.0) was reachable in **both** arms. The Fusion arm ran that older build instead of `dist/` and got the old verbose receipt for a 149-byte output. In one of those runs it failed with `Fusion: Unable to make evidence storage private (spawnSync ...powershell.exe ETIMEDOUT)`, and the model fell back to running the command natively. That message comes from the 10-second timeout around the PowerShell ACL script in `src/evidence.ts`, which can be exceeded on a loaded Windows machine. The baseline never called `fusion-jev` in that pass. The fix was `CLAUDE_ENV_FILE`, verified with probes, followed by re-running all 12 runs. Only the second pass is reported.
- **Prompt wording:** the Fusion arm's appended prompt says `fusion-jev` is installed globally and on PATH. A user of the published plugin who has no global install gets the `npx -y fusion-jev@0.3.0` form instead, which adds npx startup time. Task 2 also shows that without a `fusion-jev` binary on PATH, receipts carry the longer absolute-path argv recovery line.
- Grading is a string check, and every answer was also read by hand. The baseline task 2 answers report an additional real failure (see finding 4) and were counted as correct.
