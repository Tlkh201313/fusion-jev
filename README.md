# Fusion Jev

**Keep noisy command output small. Recover the captured evidence when you need it.**

Fusion Jev is a local CLI and MCP toolkit for developers using Codex or Claude Code. Batch known repository reads, inspect compact command diagnostics, and recover captured bytes through evidence receipts. Deterministic tools work without a key. Optional official TypeSafe Jev chooses among bounded, validated actions; uncertain work returns to your current host.

This is an independent community integration, not affiliated with TypeSafe. The code is MIT licensed; Jev is an external service. The source repository is [Tlkh201313/fusion-jev](https://github.com/Tlkh201313/fusion-jev). The npm name `fusion-jev-mcp` is provisional and the npm package remains unpublished. Version: 0.3.0. Public CLI: `fusion-jev`.

## Try it locally

Requires Git, Node 22.12+ and npm:

```sh
git clone https://github.com/Tlkh201313/fusion-jev.git
cd fusion-jev
npm ci
npm run setup
```

Setup builds the CLI, creates a private blank provider file outside the repository, and prints exact Codex and Claude connection commands. It preserves existing files and does not change host settings or install a global binary. Use `node dist/cli.js setup --dry-run` to see the commands without creating files.

Try a noisy, deliberately failing command without a key:

```sh
node dist/cli.js run '--' node -e "for (let i=0;i<200;i++) console.log('unchanged context '+i); console.error('src/example.ts:4:2 - error TS2322: fixture failure'); process.exitCode=2"
```

Expect exit code 2, a compact diagnostic, stdout/stderr receipts and recovery commands. The printed `recoverStdoutArgv` contains the exact Node/CLI arguments for your host's execution tool. To recover manually from this source checkout, copy the stdout receipt ID:

```sh
node dist/cli.js evidence RECEIPT_ID --raw
```

Recover before the receipt's ten-minute expiry. The default capture limit is 8 MiB per output stream; the local store retains at most 128 receipts and 32 MiB, so eviction may happen earlier. Check `stdoutTruncated` and `stdoutRedacted`: recovery returns retained bytes, not omitted or redacted content. This small fixture recovers all 200 context lines. The [local setup guide](docs/setup.md) covers the first MCP inspection and troubleshooting. `npm run demo` also offers a keyless scripted routing example; it does not measure Jev quality.

With the default profile, your host receives three tools:

| Tool | Use it for |
| --- | --- |
| `fusion_inspect` | Known file reads, literal searches and Git inspections; batch up to eight independent actions. |
| `fusion_assist` | A short grounded goal when the next bounded inspection is unclear. |
| `fusion_evidence` | Recover captured detail, with explicit clipping, redaction and expiry information. |

For example, ask: “Use Fusion to read the first 20 lines of this project's package.json.” An obvious read runs locally and makes no Jev call. The host retains reasoning, edits, permissions and correctness decisions.

## Compact command evidence

The host chooses the exact command and its arguments. The wrapper captures stdout and stderr, summarizes supported diagnostics, returns the child's exit status, and provides receipts for recovery:

```sh
node dist/cli.js run '--' node -e "console.log('example output')"
node dist/cli.js evidence RECEIPT_ID --raw
```

After installing a prepared local package, the equivalent command starts with `fusion-jev`. In PowerShell quote `'--'` so it reaches the CLI. `run --raw` preserves small output directly and creates no persistent receipt. Fusion does not intercept native tools, choose arbitrary shell commands, or retry side effects. Evidence is bounded and expiring; recovery returns the bytes retained after disclosed redaction and capture limits.

## Optional Jev choices

Set `TYPESAFE_API_KEY` in the private file named by setup to enable official TypeSafe Jev. The default is `https://api.typesafe.ai/v1/systemone` with `jev-latest`; `JEV_API_KEY` is a documented compatibility alias. TeamoRouter credentials are not used. [Provider and workspace configuration](docs/configuration.md), [official TypeSafe API](https://docs.typesafe.ai/api).

Jev sees the bounded state and choice descriptions supplied to it. It may select a validated candidate ID or escalate; it cannot generate executable arguments or grant permission to write. Confidence, probability and margin are separate uncalibrated gates. A network failure or missing key returns uncertain decisions to the host. Deterministic local reads do not send repository contents to Jev.

Jev requests may incur TypeSafe charges. The MCP CLI uses the current host for fallback and makes no OpenAI or Anthropic API call. Offline fixtures and bytes estimates verify orchestration and output behavior; they do not establish model quality, universal speed improvements or subscription savings.

## Local hosts and library

Start with the absolute Node/CLI commands printed by setup. Optional [Codex adapter](plugin/fusion-jev/README.md) and [Claude Code adapter](plugin/fusion-jev-claude/README.md) add native guidance. They use distinct host manifest formats. No global instructions, permissions, other plugins or skills are rewritten.

The TypeScript source also exports `FusionRouter`, `JevProvider`, `FusionExecutor`, workspace services and evidence contracts. `examples/workflow.ts` demonstrates a bounded workflow in the source checkout. Applications explicitly register execution handlers and authorization; an MCP routing decision alone executes nothing. `FUSION_MCP_PROFILE=full` exposes the additional routing and inspection surface for existing integrations. HTTP/OAuth compatibility remains in source; hosted setup is outside this release's front door.

## Develop and evaluate

```sh
npm run typecheck
npm test
npm run build
npm run benchmark
npm run pack:smoke
```

Tests run serially with credentials cleared. The evidence backend uses `better-sqlite3`; installation needs a supported Node/platform prebuild or the dependency's native build prerequisites. CI is configured for Windows, Linux and macOS; a configured matrix is not a claim that every platform has been verified for this source revision.

Read [market fit](docs/market-fit.md), [comparisons](docs/comparison.md) and the [launch plan](docs/launch-plan.md) for target users, alternatives and measurements still needed. [Contributing](CONTRIBUTING.md), [security](SECURITY.md), [release notes](CHANGELOG.md), [license](LICENSE).
