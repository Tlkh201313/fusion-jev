<div align="center">

<img src="docs/assets/hero.svg" alt="Fusion Jev: keep noisy command output small, recover the captured evidence when you need it. Works with Claude Code and Codex." width="880">

# Fusion Jev

**Keep noisy command output small. Recover the captured evidence when you need it.**

[![npm](https://img.shields.io/npm/v/fusion-jev?logo=npm)](https://www.npmjs.com/package/fusion-jev)
[![CI](https://github.com/Tlkh201313/fusion-jev/actions/workflows/ci.yml/badge.svg)](https://github.com/Tlkh201313/fusion-jev/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=22.12](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2)](https://modelcontextprotocol.io)

</div>

Fusion Jev is a local CLI and [MCP](https://modelcontextprotocol.io) server for **Claude Code** and **Codex**. It runs a command for your coding agent, hands back a compact diagnostic instead of the full log, and keeps the original bytes behind a short-lived receipt you can expand on demand. No key or account is needed for the core tools.

<!-- TODO(human): record docs/assets/demo.gif (vhs or asciinema) running the fixture below, then uncomment:
<p align="center"><img src="docs/assets/demo.gif" alt="Fusion Jev turning 200 noisy lines into one diagnostic and a receipt" width="720"></p>
-->

## See it work

<p align="center"><img src="docs/assets/before-after.svg" alt="Without Fusion the agent reads 200 noisy lines with one error at the end; with Fusion Jev it gets exitCode=2, one diagnostic, omittedBytes=4290 and a receipt ID, and the full log stays recoverable" width="880"></p>

A deliberately failing command with 200 lines of noise and one real error:

```sh
npx -y fusion-jev run '--' node -e "for (let i=0;i<200;i++) console.log('unchanged context '+i); console.error('src/example.ts:4:2 - error TS2322: fixture failure'); process.exitCode=2"
```

The host sees a compact result. This is real output from the CLI (stdout lines first, then the stderr line), trimmed only in that receipt UUIDs are shortened to their first 8 characters (`…`):

```text
termination=exit exitCode=2 durationMs=403 stdout=546e7c15-… stdoutStoredBytes=4290 stderr=1c86ca87-… stderrStoredBytes=51
omittedBytes=4290
recoverStdout=npx -y fusion-jev@0.3.0 evidence 546e7c15-… --raw
src/example.ts:4:2 - error TS2322: fixture failure
```

The process exit code (2) is preserved. The 51-byte stderr is small and complete, so it is printed verbatim and needs no recovery line; only the 4,290 bytes of stdout were left out, and they stay available behind the receipt. Flags such as `stdoutTruncated=true` appear only when they apply. When launched through `npx`, the recovery line names the pinned `npx -y fusion-jev@<version>` form; after a global install it reads `fusion-jev evidence …`. In the real output each receipt ID is a full 36-character UUID; paste the full ID when recovering:

```sh
npx -y fusion-jev@0.3.0 evidence 546e7c15-… --raw   # prints the original 200 lines
```

Output that is small to begin with (1 KiB or less across both streams, complete and valid UTF-8) is passed through unchanged with one status line, and no receipt is written:

```text
v24.12.0
exitCode=0 durationMs=54
```

## Install in 30 seconds

Needs Node 22.12+ and npm. Nothing else is required.

### Claude Code

```sh
claude mcp add fusion-jev -- npx -y fusion-jev stdio
```

Or install the plugin, which adds a short usage hint at session start:

```text
/plugin marketplace add Tlkh201313/fusion-jev
/plugin install fusion-jev@fusion-jev
```

### Codex

```sh
codex mcp add fusion-jev -- npx -y fusion-jev stdio
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.fusion-jev]
command = "npx"
args = ["-y", "fusion-jev", "stdio"]
```

### Native Windows

If the host reports `Connection closed` or `ENOENT` for `npx` (it is a `.cmd` shim), add the Claude Code server with the `cmd` wrapper instead of the plugin: `claude mcp add fusion-jev -- cmd /c npx -y fusion-jev stdio`. This is the reported workaround ([anthropics/claude-code#20061](https://github.com/anthropics/claude-code/issues/20061)), not something Claude Code's MCP docs describe. For Codex, no Windows-specific `npx` form is documented; use the absolute-path command from `fusion-jev setup --dry-run` after a global install. Details: [docs/install.md](docs/install.md#windows-notes).

### CLI only

```sh
npx -y fusion-jev run '--' npm test        # quote '--' in PowerShell
npx -y fusion-jev evidence RECEIPT_ID --raw

# or install once
npm install -g fusion-jev
fusion-jev setup        # prints connection commands; use --dry-run to preview
fusion-jev doctor       # local readiness check, no network
```

Then ask your agent: "Use Fusion to read the first 20 lines of package.json." Full steps for every host, Windows notes and troubleshooting: [docs/install.md](docs/install.md).

## What you get

The default profile exposes three MCP tools:

| Tool | Use it for |
| --- | --- |
| `fusion_inspect` | Known file reads, literal searches and Git inspections; batch up to eight independent actions. |
| `fusion_assist` | A short grounded goal when the next bounded inspection is unclear. |
| `fusion_evidence` | Recover captured detail with explicit clipping, redaction and expiry information. |

Commands are run through the CLI wrapper, `npx -y fusion-jev run -- program args...` (or `fusion-jev run -- program args...` after a global install), chosen and authorized by your host. Fusion does not intercept native tools or pick arbitrary shell commands.

## How it works

<p align="center"><img src="docs/assets/how-it-works.svg" alt="Flow: host runs fusion-jev run or calls the MCP server; the executor captures output, stores original bytes in a local expiring receipt store, and returns a compact diagnostic plus receipt IDs; the host expands receipts with fusion_evidence or fusion-jev evidence" width="880"></p>

```mermaid
flowchart LR
  Host["Host<br/>(Claude Code / Codex)"] -->|MCP tools| Server["fusion-jev stdio"]
  Host -->|"npx -y fusion-jev run -- cmd"| Exec["Executor<br/>captures stdout and stderr"]
  Server --> Exec
  Exec -->|"redact known secrets, cap size"| Store[("Receipt store<br/>local, private, expiring")]
  Exec -->|"compact diagnostic + receipt IDs"| Host
  Host -->|"fusion_evidence / evidence ID"| Store
  Server -.->|"optional: choose among validated actions"| Jev["Jev<br/>(TypeSafe API)"]
```

- **Capture.** The wrapper runs your command, keeps stdout and stderr, and preserves the exit status.
- **Summarize.** Supported diagnostics become short entries with byte ranges; small output is passed through.
- **Receipt.** Captured bytes are stored locally and referenced by ID, so the full output can be recovered without rerunning the command.
- **Escalate.** Anything uncertain goes back to your current host session. Fusion never makes its own model call to Anthropic or OpenAI.

More detail, including the receipt lifecycle: [docs/how-it-works.md](docs/how-it-works.md).

## Jev (optional)

If you set `TYPESAFE_API_KEY`, Fusion can ask TypeSafe's Jev to pick among a short list of pre-validated actions for routine goals. Jev only selects an ID from that list; it cannot write commands, arguments or code, and it cannot grant permission. Without a key, deterministic tools still work and uncertain choices return to your host. See [docs/configuration.md](docs/configuration.md).

## Glossary

- **Host**: the coding agent that runs Fusion, such as Claude Code or Codex. It keeps reasoning, edits, command authorization and correctness decisions.
- **Receipt**: an ID for captured command output or inspection data, stored locally and expandable through `fusion_evidence` or `npx -y fusion-jev evidence ID`.
- **Jev**: a model service from TypeSafe ([docs](https://docs.typesafe.ai/api)) that Fusion can optionally consult to choose among validated candidate actions. Fusion Jev is an independent community integration and is not affiliated with TypeSafe.
- **Escalation**: returning an uncertain decision to the host instead of guessing.
- **Profile**: the tool set the MCP server exposes. `assist` (default) has the three tools above; `FUSION_MCP_PROFILE=full` adds routing and inspection tools.

## FAQ

**Does it send my code anywhere?** Local reads, searches, Git inspection and command capture stay on your machine. If you configure a TypeSafe key, Jev receives only the bounded task text and candidate descriptions Fusion sends it; the only network destination the CLI contacts is the official TypeSafe API, and only when a key is set.

**Do I need a key?** No. Compact command evidence and the three tools work without one. A key only enables optional Jev choices.

**What does it cost?** Fusion Jev is free and MIT licensed. Jev requests, if you enable them, are billed by TypeSafe under its terms. Fallback uses your current host session, not a separate API.

**How is it different from RTK or Context7?** RTK's main product is filtering command output across many commands, and it offers its own recall. Context7 retrieves current library documentation. Fusion Jev focuses on MCP tools plus receipts for recovering captured output and bounded inspections. They can coexist. See [docs/comparison.md](docs/comparison.md).

More questions and troubleshooting: [docs/faq.md](docs/faq.md).

## Limits

- Receipts expire after 10 minutes. The store keeps at most 128 receipts and 32 MiB, so older ones can be evicted sooner.
- Each output stream is captured up to 8 MiB. Watch for `stdoutTruncated=true` or `stdoutRedacted=true` (these flags are printed only when they apply): recovery returns the retained bytes, not omitted or redacted content. Redaction matches known secret patterns and is not a guarantee that output holds no secrets.
- Tiny outputs (1 KiB or less in total) are passed through verbatim plus one status line, so they cost a few bytes more than the raw output and create no receipt.
- The evidence store uses `better-sqlite3`, a native module. Installation needs a prebuilt binary for your Node/platform or a local build toolchain (see [docs/install.md](docs/install.md)).
- Token or speed savings have not been measured on real hosts yet. The method and an empty results table are in [benchmark/real-host.md](https://github.com/Tlkh201313/fusion-jev/blob/main/benchmark/real-host.md); no savings figure is claimed.
- Jev's confidence and probability values are uncalibrated gates, and a configured key is not proof it works.

## Develop

```sh
git clone https://github.com/Tlkh201313/fusion-jev.git && cd fusion-jev
npm ci
npm run check        # typecheck + tests + build
npm run pack:smoke   # install the packed tarball in a clean directory
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](https://github.com/Tlkh201313/fusion-jev/blob/main/CODE_OF_CONDUCT.md), [CHANGELOG.md](CHANGELOG.md) and the [docs index](docs/README.md). Released under the [MIT license](LICENSE).
