# Optional Claude Code adapter

Use [local setup](../../docs/setup.md) first. The native plugin requires the public `fusion-jev` CLI on the host's PATH; a source MCP connection with an absolute Node/CLI path works without global installation.

From a prepared source checkout, after installing a local public tarball yourself:

```text
claude plugin validate plugin/fusion-jev-claude --strict
claude plugin marketplace add ./
claude plugin install fusion-jev@fusion-local --scope user
```

Reload plugins or start a fresh chat. This adapter uses Claude's `.claude-plugin/plugin.json`, `env` mapping, `${CLAUDE_PROJECT_DIR}` and native SessionStart hook. It retains separate Codex schemas. [Official native plugin reference](https://code.claude.com/docs/en/plugins-reference), [MCP setup](https://code.claude.com/docs/en/mcp).

The hook supplies short usage guidance; `/fusion-jev:assist` supplies focused optional instructions. It does not rewrite commands or permissions. Save a trusted private provider file with `fusion-jev config env-file ABSOLUTE_PATH`; `TYPESAFE_API_KEY` enables official Jev. Deterministic tools remain usable without it; `fusion-jev doctor stdio` makes no network request.

Claude keeps reasoning, edits, execution authorization and correctness. Run host-chosen commands through `fusion-jev run '--' program argv...` in PowerShell. Recover retained output through `fusion_evidence` or `fusion-jev evidence ID --raw`. Host escalation requires no Anthropic or OpenAI API key. Installing this adapter does not remove or alter unrelated skills, hooks, instruction files or plugins.
