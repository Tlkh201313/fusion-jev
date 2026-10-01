# Real-host measurement

Offline fixtures in this repo verify output handling. They do not show what a real host sees or what a task costs. This page is a method and an empty results table. **Every number is `TBD` until someone runs the steps below; do not fill in estimates.**

## What to measure

For each workload, compare the output the host would receive natively with what it receives through `npx -y fusion-jev run`, and check that the original is recoverable.

| Workload | Command (run in a real project) |
| --- | --- |
| Failing type check | `tsc --noEmit` in a project with errors |
| Failing tests | `npm test` in a project with failing tests |
| Large Git output | `git log -p -n 200` |
| Failing build | `npm run build` in a project that fails to build |

Use projects large enough that the output is genuinely noisy. Record the project, its size and its Node/tool versions with the results.

## Method

Use the same command, working directory and repository state for both runs. In PowerShell, quote the separator: `npx -y fusion-jev run '--' ...`.

1. **Raw bytes.** Run the command natively and capture both streams: `cmd > raw.txt 2>&1`, then `wc -c raw.txt` (or `(Get-Item raw.txt).Length` on PowerShell).
2. **Compact bytes.** Run `npx -y fusion-jev run -- cmd > compact.txt 2>&1` and measure `compact.txt` the same way. This includes the summary, receipt IDs and recovery lines, which is what the host receives.
3. **Estimated tokens.** Report raw and compact bytes divided by 4 as an estimate, and label it as one. If your host shows real token usage for a tool result, record that as well in a separate column or note, and say how it was read.
4. **Recovery.** Copy the stdout receipt ID from the compact output, then run `npx -y fusion-jev evidence ID --raw > recovered.txt` within 10 minutes and compare it with the native stdout (for example `cmp`). Record Y only for a byte-exact match, and note any `stdoutTruncated` or `stdoutRedacted` flags.
5. **Task check (optional).** Ask the host to diagnose the failure from the compact result and note whether it needed to expand a receipt. Record how many expansions it needed.
6. Repeat each workload several times. Report the number of runs and the spread, not only the best run.

Always record the host, host version, OS and date. Keep small-output and slow-start cases in the table; do not drop workloads that look unfavorable.

## Results

| Workload | Raw bytes | Compact bytes | Est. tokens raw (bytes/4) | Est. tokens compact (bytes/4) | Receipt recovered (Y/N) | Host | Date |
| --- | ---: | ---: | ---: | ---: | :---: | --- | --- |
| Failing `tsc` | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| `npm test` failure | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| `git log -p` | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Failing build | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

Notes (versions, project, runs, flags seen, host-reported token usage): TBD
