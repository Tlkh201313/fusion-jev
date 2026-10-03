# Install

Fusion Jev needs **Node 22.12+** and npm. Pick your host below; each path starts the same MCP server (`fusion-jev stdio`). Package, marketplace and plugin names on this page are all `fusion-jev`.

- [Claude Code](#claude-code)
- [Codex](#codex)
- [CLI only](#cli-only)
- [From source](#from-source)
- [Optional: enable Jev](#optional-enable-jev)
- [Workspace roots](#workspace-roots)
- [Verify](#verify)
- [Windows notes](#windows-notes)
- [Troubleshooting](#troubleshooting)

## Claude Code

MCP server only:

```sh
claude mcp add fusion-jev -- npx -y fusion-jev stdio
```

Or the plugin, which adds the MCP server, a short session-start usage hint and the `/fusion-jev:assist` skill:

```text
/plugin marketplace add Tlkh201313/fusion-jev
/plugin install fusion-jev@fusion-jev
```

Reload plugins or start a new chat. See [plugin/fusion-jev-claude](../plugin/fusion-jev-claude/README.md). Official reference: [Claude Code MCP](https://code.claude.com/docs/en/mcp).

## Codex

```sh
codex mcp add fusion-jev -- npx -y fusion-jev stdio
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.fusion-jev]
command = "npx"
args = ["-y", "fusion-jev", "stdio"]
```

Restart the Codex session after changing configuration. See [plugin/fusion-jev](../plugin/fusion-jev/README.md) for the optional native adapter. Official reference: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## CLI only

No install:

```sh
npx -y fusion-jev run '--' npm test
npx -y fusion-jev evidence RECEIPT_ID --raw
```

Global install:

```sh
npm install -g fusion-jev
fusion-jev setup --dry-run   # preview, writes nothing
fusion-jev setup             # creates a private provider template and prints connection commands
fusion-jev doctor            # local check; makes no network request
```

`run` options (all before the `--`): `--raw` (print output directly, no receipt), `--timeout-ms=N`, `--max-capture-bytes=N`, `--cwd=ABSOLUTE_PATH`. `evidence` options: `--start-byte=N`, `--max-bytes=N` (at most 65536), `--raw`. Run `fusion-jev --help` for the full list.

## From source

```sh
git clone https://github.com/Tlkh201313/fusion-jev.git
cd fusion-jev
npm ci
npm run setup      # builds, then runs setup
```

Setup prints Codex and Claude connection commands that use absolute Node and CLI paths, so no global binary is needed. It preserves existing files and does not change host settings. `node dist/cli.js setup --dry-run` shows the commands without creating files.

## Optional: enable Jev

Everything above works without a key. To let Fusion consult TypeSafe's Jev for bounded choices, put `TYPESAFE_API_KEY` in the private provider file that `fusion-jev setup` created (it prints the path), or set it in the host's launch environment. Get a key from [TypeSafe's quick start](https://docs.typesafe.ai/introduction/quickstart). Never put a key on a command line, in an issue, or in a plugin manifest.

Use an existing trusted file with `fusion-jev setup --provider-env=/absolute/path/to/provider.env`, or change the saved path later with `fusion-jev config env-file /absolute/path/to/provider.env` (`--clear` removes it). Full settings: [configuration.md](configuration.md).

## Workspace roots

The server permits the canonical directory it starts in. If your host starts MCP servers elsewhere, set `FUSION_WORKSPACE_ROOT` in the launch environment. Extra exact roots go in `FUSION_WORKSPACE_ALLOWED_ROOTS`, separated by `;` on Windows or `:` on Linux/macOS. Use a tool's `path` argument for subdirectories; a nested directory is not automatically a new approved root.

## Verify

```sh
npx -y fusion-jev doctor stdio    # or: fusion-jev doctor stdio after a global install
```

Expect `"status": "ready"` and, without a key, a warning that the optional provider is missing. Doctor never calls a provider and always reports `liveConnectivity: "not-tested"`. Then ask your host: "Use Fusion to read the first 20 lines of this project's package.json." In Claude Code, `/mcp` lists connected servers.

## Windows notes

- **PowerShell and `--`.** PowerShell can swallow a bare `--`. Quote it: `npx -y fusion-jev run '--' npm test` (or `fusion-jev run '--' npm test` after a global install).
- **`npx` as an MCP command (native Windows, not WSL).** `npx` is a `.cmd` shim, and a host that starts MCP servers without a shell can fail with `Connection closed` or `ENOENT`. For Claude Code, wrap it: `claude mcp add fusion-jev -- cmd /c npx -y fusion-jev stdio`. Claude Code is reported to print "Windows requires 'cmd /c' wrapper to execute npx" for a bare `npx` ([anthropics/claude-code#20061](https://github.com/anthropics/claude-code/issues/20061)); that issue also reports `/c` being rewritten into a path by `claude mcp add`, in which case edit the saved entry to `"command": "cmd"`, `"args": ["/c", "npx", "-y", "fusion-jev", "stdio"]`. The `cmd /c` wrapper is not described in Claude Code's current MCP documentation, so treat it as a reported workaround. The Claude plugin's `.mcp.json` uses a bare `npx` (no OS-specific plugin setting is documented), so on native Windows add the server with the command above instead of the plugin. The Codex MCP documentation gives no Windows-specific `npx` form, and none is verified here.
- **No shell shim at all.** After `npm install -g fusion-jev`, `fusion-jev setup --dry-run` prints `claude mcp add` and `codex mcp add` commands that run `node.exe` on the CLI file by absolute path. Use those if `npx` will not start under your host.
- **Native module.** Evidence storage uses `better-sqlite3`. npm normally downloads a prebuilt binary. If your Node version or architecture has none, npm falls back to compiling, which needs Python and the Visual Studio C++ build tools. Install those, or use a supported Node LTS, then reinstall.
- **Config location.** Setup stores configuration under `~/.fusion-jev-mcp` on Windows. If a location is reported unsafe, set `FUSION_CONFIG_HOME` to an absolute base directory owned by you and not writable by other users.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `command not found` / server fails to start | Confirm `node --version` is 22.12 or newer and that the host can run `npx`. With a global install, make sure npm's bin directory is on the PATH the host sees, then restart the host. |
| `Connection closed` or `ENOENT` on native Windows | The host could not start the `npx` shim. See [Windows notes](#windows-notes): use `claude mcp add fusion-jev -- cmd /c npx -y fusion-jev stdio`, or the absolute-path command from `fusion-jev setup --dry-run`. |
| `better-sqlite3` build or `bindings` error | See [Windows notes](#windows-notes). On Linux/macOS install a C/C++ toolchain and Python, or use a Node version with a prebuilt binary. |
| Jev reported missing | Expected without a key; local tools still work. Set `TYPESAFE_API_KEY` in the private provider file or launch environment. Doctor confirms presence, not validity. |
| Root rejected | Approve the exact project root via `FUSION_WORKSPACE_ROOT` or `FUSION_WORKSPACE_ALLOWED_ROOTS`. Fusion does not inherit every directory your host can read. |
| `Evidence missing` / `expired` | Receipts expire after 10 minutes and are capped at 128 receipts / 32 MiB. The CLI and the MCP server must run as the same user so they share the `fusion-jev-mcp` cache directory. |
| Output looks redacted or clipped | Look for `stdoutTruncated=true` / `stdoutRedacted=true` (or the `stderr` equivalents) on the status line; these flags are printed only when they apply. Recovery returns retained bytes only. |
| Config location reported unsafe | Set `FUSION_CONFIG_HOME` as described above. Fusion never loosens permission checks. |

The package and command are `fusion-jev`, but the configuration and evidence directory name stays `fusion-jev-mcp` for continuity, separate from any other installation of a command named `fusion`. To clear stored receipts, delete the evidence directory: `%LOCALAPPDATA%\fusion-jev-mcp\evidence` on Windows, or `${XDG_CACHE_HOME:-~/.cache}/fusion-jev-mcp/evidence` on Linux and macOS. Configuration lives in `~/.fusion-jev-mcp` on Windows and `${XDG_CONFIG_HOME:-~/.config}/fusion-jev-mcp` elsewhere (`FUSION_CONFIG_HOME` overrides the base).
