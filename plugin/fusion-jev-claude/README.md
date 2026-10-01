# Fusion Jev for Claude Code

A native Claude Code plugin that starts the Fusion Jev MCP server and adds short usage guidance. It needs Node 22.12+ and downloads the server on first use via `npx`; no global install is required.

## Install

```text
/plugin marketplace add Tlkh201313/fusion-jev
/plugin install fusion-jev@fusion-jev
```

Reload plugins or start a new chat, then check `/mcp`. Prefer no plugin? Add just the server:

```sh
claude mcp add fusion-jev -- npx -y fusion-jev stdio
```

## What it adds

- The MCP server, launched as `npx -y fusion-jev stdio`, with `FUSION_MCP_PROFILE=assist` (tools: `fusion_inspect`, `fusion_assist`, `fusion_evidence`) and `FUSION_WORKSPACE_ROOT` set to the current project.
- A SessionStart hook that supplies a short usage hint.
- The `/fusion-jev:assist` skill with focused instructions for the tools.

The plugin does not rewrite commands, permissions, or unrelated skills, hooks, instruction files and plugins. Claude keeps reasoning, edits, command authorization and correctness decisions.

## Running commands through Fusion

Claude runs the command it chooses through its normal Bash tool:

```sh
npx -y fusion-jev run '--' npm test
```

If you installed the CLI globally (`npm install -g fusion-jev`), use `fusion-jev run -- npm test`. In PowerShell, quote the separator as `'--'`. Recover output with the `fusion_evidence` tool or `fusion-jev evidence ID --raw` within 10 minutes. See the [install guide](../../docs/install.md).

## Optional: Jev

Deterministic tools work without a key. To enable optional Jev choices, save a trusted private provider file with `fusion-jev config env-file ABSOLUTE_PATH` and set `TYPESAFE_API_KEY` in it. See [configuration](../../docs/configuration.md).

## Develop

From a repository checkout:

```text
claude plugin validate plugin/fusion-jev-claude --strict
claude plugin marketplace add ./
claude plugin install fusion-jev@fusion-jev --scope user
```

Official references: [plugins](https://code.claude.com/docs/en/plugins-reference), [MCP](https://code.claude.com/docs/en/mcp).
