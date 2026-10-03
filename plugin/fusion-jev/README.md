# Fusion Jev for Codex

An optional Codex adapter that starts the Fusion Jev MCP server and describes its tools to Codex. It needs Node 22.12+ and downloads the server on first use via `npx`; no global install is required.

## Simplest install

You do not need the adapter to use Fusion Jev with Codex:

```sh
codex mcp add fusion-jev -- npx -y fusion-jev stdio
```

or, in `~/.codex/config.toml`:

```toml
[mcp_servers.fusion-jev]
command = "npx"
args = ["-y", "fusion-jev", "stdio"]
```

On Windows, Codex's MCP documentation gives no `npx`-specific form, and no wrapper is verified here. If `npx` fails to start, install globally (`npm install -g fusion-jev`) and use the absolute-path `codex mcp add` command that `fusion-jev setup --dry-run` prints; it runs `node.exe` on the CLI file directly and needs no `.cmd` shim. See the [install guide](../../docs/install.md#windows-notes).

Reload the MCP connection afterwards. [Official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Using the adapter

Import this folder through Codex's local plugin workflow. Its `.mcp.json` launches `npx -y fusion-jev@<version> stdio` (pinned to this adapter's version) and forwards environment variable names (not values) such as `TYPESAFE_API_KEY`, `FUSION_ENV_FILE`, `FUSION_WORKSPACE_ROOT` and `FUSION_WORKSPACE_ALLOWED_ROOTS`. The portable `plugin.json` and the `.codex-plugin/plugin.json` manifest describe the same adapter and advertise `fusion_assist`, `fusion_inspect` and `fusion_evidence`.

Set the intended `FUSION_WORKSPACE_ROOT`, and any extra `FUSION_WORKSPACE_ALLOWED_ROOTS`, in the host launch environment. Native guidance is a preference: Codex retains reasoning, command authorization and correctness.

## Running commands through Fusion

```sh
npx -y fusion-jev run '--' npm test
```

With a global install (`npm install -g fusion-jev`) use `fusion-jev run -- npm test`. In PowerShell, quote the separator as `'--'`; `--raw` prints small output directly. Expand a receipt with the `fusion_evidence` tool or `npx -y fusion-jev evidence ID --raw` within 10 minutes. See the [install guide](../../docs/install.md).

## Optional: Jev

Deterministic tools work without a key. To enable optional Jev choices, save a trusted private provider file with `npx -y fusion-jev config env-file ABSOLUTE_PATH` (or forward `FUSION_ENV_FILE`) and set `TYPESAFE_API_KEY` in it. See [configuration](../../docs/configuration.md).
