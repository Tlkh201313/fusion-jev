# Fusion Jev

**Your coding agent sees the error, not 2,000 passing lines, and it can always get every captured byte back.**

`fusion-jev run -- npm test` runs the command you chose, returns its exact exit status, a compact diagnostic and evidence receipts, and keeps the captured output recoverable. It ships as a CLI, an MCP server and native Claude Code and Codex adapters. Everything works locally without an API key. It complements tools such as [RTK](https://github.com/rtk-ai/rtk): compaction here is reversible through receipts.

| Output (measured on this revision, bytes the host receives) | Native | `fusion-jev run` |
| --- | ---: | ---: |
| Failing check: 200 context lines and one TypeScript error | 4,341 B | 985 B |
| Passing suite: 3,000 lines | 79,890 B | ~900 B |
| One short line | 5 B | ~890 B, so use `--raw` |

These are bytes, not host-reported tokens. Check your own numbers with `fusion-jev gain`.

## Install

> The npm package `fusion-jev-mcp` is prepared but **not published yet**. Until it is, use [Try from source](#try-from-source). The commands below are the post-publish path.

```sh
# Claude Code plugin (MCP tools, session hint, optional auto-wrap)
/plugin marketplace add Tlkh201313/fusion-jev
/plugin install fusion-jev@fusion-local

# Or any MCP host
claude mcp add fusion -- npx -y --package=fusion-jev-mcp fusion-jev stdio
codex mcp add fusion -- npx -y --package=fusion-jev-mcp fusion-jev stdio

# Try it on one command without installing
npx -y --package=fusion-jev-mcp fusion-jev run -- npm test
```

Requires Node 22.13+. There is no native build step. On native Windows, prefix `npx` with `cmd /c` when adding an MCP server by hand.

## Use it

```sh
fusion-jev run -- npm test               # exit status, compact diagnostic, receipts
fusion-jev evidence RECEIPT_ID --raw     # recover the captured bytes
fusion-jev run --raw -- git status       # small output: pass through exactly
fusion-jev gain                          # what was kept out of context on this machine
```

The host model receives three MCP tools:

| Tool | Use it for |
| --- | --- |
| `fusion_inspect` | Known file reads, literal searches and Git inspections; batch up to eight independent actions. |
| `fusion_assist` | A short grounded goal when the next bounded inspection is unclear. |
| `fusion_evidence` | Recover captured detail, with explicit clipping, redaction and expiry information. |

**Auto-wrap (Claude Code, opt-in):** `fusion-jev config auto-wrap on` lets the plugin route simple noisy commands (tests, builds, linters, type checkers) through `fusion-jev run` automatically. It never touches permissions, and anything it doesn't recognize passes through unchanged. See the [Claude adapter](plugin/fusion-jev-claude/README.md).

**Status line:** to see savings continuously at no model-token cost, add this to Claude Code's `settings.json`:

```json
{ "statusLine": { "type": "command", "command": "fusion-jev statusline" } }
```

## Try from source

```sh
git clone https://github.com/Tlkh201313/fusion-jev.git
cd fusion-jev
npm ci
npm run setup
```

Setup builds the CLI, creates a private blank provider file outside the repository and prints exact Codex and Claude connection commands. It does not change host settings or install a global binary; `node dist/cli.js setup --dry-run` shows the commands only. Try a deliberately failing command:

```sh
node dist/cli.js run '--' node -e "for (let i=0;i<200;i++) console.log('unchanged context '+i); console.error('src/example.ts:4:2 - error TS2322: fixture failure'); process.exitCode=2"
```

Expect exit code 2, a compact diagnostic, stdout/stderr receipts and recovery commands. `recoverStdoutArgv` contains the exact Node/CLI arguments for your host's execution tool. In PowerShell, quote `'--'`. The [local setup guide](docs/setup.md) covers the first MCP inspection and troubleshooting.

## Optional: Jev routing

Set `TYPESAFE_API_KEY` in the private file named by setup to enable official TypeSafe Jev (`https://api.typesafe.ai/v1/systemone`, `jev-latest`; `JEV_API_KEY` is an alias). Jev only selects a validated candidate ID or escalates. It cannot generate executable arguments or grant write permission, and obvious reads never call it. Jev requests may incur TypeSafe charges. A network failure or missing key hands the decision back to your host. See [provider and workspace configuration](docs/configuration.md) and the [TypeSafe API](https://docs.typesafe.ai/api). Fusion Jev is an independent community integration, not affiliated with TypeSafe, OpenAI or Anthropic.

## Limits

- Receipts expire after ten minutes. The local store keeps at most 128 receipts and 32 MiB, and capture stops at 8 MiB per stream. Recovery returns the retained bytes: check `stdoutTruncated` and `stdoutRedacted`.
- Known credential formats are redacted before storage. Redacted bytes cannot be recovered.
- Fusion does not choose commands, retry side effects or change permissions; the host keeps reasoning, edits and correctness decisions.
- Byte reductions are not token, bill or speed guarantees. Small outputs grow with receipt overhead.
- Fixed context per default Claude session is about 5 KB (tool schemas, instructions and the session hint). Measure it with `npm run overhead`.

## Library and profiles

The TypeScript package exports `FusionRouter`, `JevProvider`, `FusionExecutor`, workspace services and evidence contracts; `examples/workflow.ts` shows a bounded workflow. `FUSION_MCP_PROFILE=full` exposes the additional routing and inspection tools for existing integrations. HTTP/OAuth compatibility remains in source.

## Develop and evaluate

```sh
npm run typecheck
npm test
npm run build
npm run benchmark
npm run overhead
npm run pack:smoke
```

Tests run serially with credentials cleared. The evidence backend uses Node's built-in `node:sqlite`. CI covers Windows, Linux and macOS. See [market fit](docs/market-fit.md), [comparisons](docs/comparison.md) and the [launch plan](docs/launch-plan.md); also [contributing](CONTRIBUTING.md), [security](SECURITY.md), [release notes](CHANGELOG.md) and the [license](LICENSE).
