# Local setup

Fusion Jev is a community tool for local Codex and Claude Code workflows. It is not affiliated with TypeSafe. Node 22.13+ and npm are required. The source is MIT licensed; Jev is an external TypeSafe service.

From a source checkout:

```sh
npm ci
npm run demo
npm run setup
```

The demo uses scripted providers and needs no key or network. Setup builds the CLI, creates a private `provider.env` template outside the repository, and prints exact host connection commands for your machine. It does not install a global command or modify a host configuration. `node dist/cli.js setup --dry-run` prints the plan without writing files.

Run the printed doctor command to confirm local capabilities. Without a key, doctor exits zero and reports the optional Jev provider as missing. Deterministic inspection still works. Doctor makes no network request and always reports `liveConnectivity: "not-tested"`.

To enable bounded Jev choices, edit the private file that setup names and fill in `TYPESAFE_API_KEY` with an official TypeSafe API key. Get a key through [TypeSafe's quick start](https://docs.typesafe.ai/introduction/quickstart). Never put a key on a command line, in an issue, or in a plugin manifest. [Configuration](configuration.md) describes provider and workspace settings.

If you already have a trusted provider file, use its absolute path:

```sh
node dist/cli.js setup --provider-env=/absolute/path/to/provider.env
```

Setup preserves existing provider files and settings. To explicitly change the saved file later, use `node dist/cli.js config env-file /absolute/path/to/provider.env`. `config env-file --clear` removes only the saved path. A `--provider-env=` option overrides the saved path for a single invocation. Fusion never searches a working directory for `.env`. Source npm scripts may explicitly load the checkout's `.env`; keep it ignored.

## Connect a host

Copy the Codex or Claude command printed by setup. It uses absolute Node and compiled CLI paths, so it does not depend on a global binary. The server name is `fusion-jev`; the default profile exposes `fusion_assist`, `fusion_inspect`, and `fusion_evidence`. Reload the MCP connection after adding it. [Official Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [official Claude MCP setup](https://code.claude.com/docs/en/mcp).

For the first useful call, ask your host: “Use Fusion to read the first 20 lines of this project's package.json.” A known read uses deterministic `fusion_inspect` and sends no request to Jev. Use `fusion_assist` when the next bounded read is unclear, and `fusion_evidence` to recover captured detail. Host instructions guide tool choice; they cannot force it.

The server permits the canonical directory it starts in by default. Set `FUSION_WORKSPACE_ROOT` in the host's launch environment to an intended project if its MCP working directory differs. Additional exact permitted roots use `FUSION_WORKSPACE_ALLOWED_ROOTS`, separated by `;` on Windows or `:` on Linux/macOS. Use a tool's `path` to inspect a subdirectory; a nested directory is not automatically an approved new root.

Optional native adapters live in [plugin/fusion-jev](../plugin/fusion-jev/README.md) and [plugin/fusion-jev-claude](../plugin/fusion-jev-claude/README.md). They require the separately installed `fusion-jev` public CLI and keep host-specific manifest formats. The current npm name `fusion-jev-mcp` is provisional and unpublished; source installation is the verified preparation path. To install a prepared local tarball, run `npm install -g /absolute/path/to/fusion-jev-mcp-0.3.0.tgz` yourself, then check `fusion-jev --help` in the environment launching your host.

## Troubleshooting

- **Command not found:** use the absolute Node/CLI commands from setup. If choosing a global install, ensure the host sees npm's executable directory and restart it after PATH changes.
- **Jev missing:** local tools remain available. Edit the private provider file or set `TYPESAFE_API_KEY` in the host's launch environment. Doctor confirms presence, not credential validity or connectivity.
- **Root rejected:** approve the intended exact canonical project root in launch configuration. Fusion does not inherit every directory the host can access.
- **Missing evidence:** the CLI and MCP process must use the same user and `fusion-jev-mcp` cache directory. Receipts expire; redaction and capture limits can omit sensitive or oversized output.

Public configuration and evidence use `fusion-jev-mcp`, separate from an existing `fusion` / `fusion-jev` private installation. The public command is `fusion-jev`. Preparation does not alter another installation or its credentials.

On Windows, setup stores its own configuration under `~/.fusion-jev-mcp`, which avoids assuming AppData has private parent permissions. If a chosen config location is reported unsafe, use `FUSION_CONFIG_HOME` with an absolute base directory owned by you and protected from other users' writes; Fusion keeps its `fusion-jev-mcp` subdirectory there. It does not loosen the permission check or change an existing profile ACL.
