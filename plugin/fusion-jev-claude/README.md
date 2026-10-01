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

### Native Windows

On native Windows (not WSL), `npx` is a `.cmd` shim. A bare `npx` server entry can fail to start with `Connection closed` or `ENOENT` (Claude Code is reported to warn "Windows requires 'cmd /c' wrapper to execute npx"; see [anthropics/claude-code#20061](https://github.com/anthropics/claude-code/issues/20061)). The plugin's `.mcp.json` uses a bare `npx` because no OS-specific plugin setting is documented, so on native Windows add the server directly with the wrapper instead of installing the plugin:

```sh
claude mcp add fusion-jev -- cmd /c npx -y fusion-jev stdio
```

If `/c` is rewritten into a path, edit the saved entry to `"command": "cmd"` and `"args": ["/c", "npx", "-y", "fusion-jev", "stdio"]`. The `cmd /c` wrapper is the workaround reported in that issue; it is not described in Claude Code's current MCP documentation. A form that needs no shell shim: after `npm install -g fusion-jev`, use the absolute-path command that `fusion-jev setup --dry-run` prints (see the [install guide](../../docs/install.md#windows-notes)).

## What it adds

- The MCP server, launched as `npx -y fusion-jev@<version> stdio` (pinned to this plugin's version), with `FUSION_MCP_PROFILE=assist` (tools: `fusion_inspect`, `fusion_assist`, `fusion_evidence`) and `FUSION_WORKSPACE_ROOT` set to the current project.
- A SessionStart hook that supplies a short usage hint.
- The `/fusion-jev:assist` skill with focused instructions for the tools.

The plugin does not rewrite commands, permissions, or unrelated skills, hooks, instruction files and plugins. Claude keeps reasoning, edits, command authorization and correctness decisions.

## Running commands through Fusion

Claude runs the command it chooses through its normal Bash tool:

```sh
npx -y fusion-jev run '--' npm test
```

If you installed the CLI globally (`npm install -g fusion-jev`), use `fusion-jev run -- npm test` instead of the `npx -y` form. In PowerShell, quote the separator as `'--'`. Recover output with the `fusion_evidence` tool or `npx -y fusion-jev evidence ID --raw` within 10 minutes. See the [install guide](../../docs/install.md).

## Optional: Jev

Deterministic tools work without a key. To enable optional Jev choices, save a trusted private provider file with `npx -y fusion-jev config env-file ABSOLUTE_PATH` and set `TYPESAFE_API_KEY` in it. See [configuration](../../docs/configuration.md).

## Develop

From a repository checkout:

```text
claude plugin validate plugin/fusion-jev-claude --strict
claude plugin marketplace add ./
claude plugin install fusion-jev@fusion-jev --scope user
```

Official references: [plugins](https://code.claude.com/docs/en/plugins-reference), [MCP](https://code.claude.com/docs/en/mcp).
