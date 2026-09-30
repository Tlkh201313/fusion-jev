# Optional Codex adapter

Use the source setup commands in [local setup](../../docs/setup.md) first. This optional native adapter assumes `fusion-jev` is installed and on the PATH seen by Codex. Install a prepared local package yourself with `npm install -g /absolute/path/to/fusion-jev-mcp-0.3.0.tgz`, then confirm `fusion-jev --help`. The npm registry name remains provisional and unpublished.

Import this adapter through Codex's local plugin workflow. Its `.mcp.json` launches `fusion-jev stdio` and forwards environment variable names without storing credential values. Save a trusted private provider path with `fusion-jev config env-file ABSOLUTE_PATH` or forward `FUSION_ENV_FILE`; `TYPESAFE_API_KEY` enables optional official Jev calls. Reload the connection after installing. [Official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The portable `plugin.json` and `.codex-plugin/plugin.json` compatibility manifest describe the same local adapter. It advertises `fusion_assist`, `fusion_inspect` and `fusion_evidence`. Native guidance is a preference; Codex retains reasoning, command authorization and correctness. Commands chosen by the host use `fusion-jev run '--' program argv...` in PowerShell; `--raw` preserves small direct output. Receipts can be expanded with `fusion_evidence` or `fusion-jev evidence ID --raw`.

Set the intended exact `FUSION_WORKSPACE_ROOT` and any additional `FUSION_WORKSPACE_ALLOWED_ROOTS` in the host launch environment. A copied plugin still relies on the public CLI; for a checkout without global installation, use the absolute Node/CLI connection printed by setup.
