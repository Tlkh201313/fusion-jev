# Claude Code adapter

Install from the repository marketplace:

```text
/plugin marketplace add Tlkh201313/fusion-jev
/plugin install fusion-jev@fusion-local
```

The plugin starts the MCP server with `npx -y --package=fusion-jev-mcp@<version> fusion-jev stdio`, so no global install is needed (Node 22.13+). On native Windows, if Claude Code cannot launch `npx` directly, add the server manually with `claude mcp add fusion -- cmd /c npx -y --package=fusion-jev-mcp fusion-jev stdio`.

From a source checkout instead: `claude plugin validate plugin/fusion-jev-claude --strict`, `claude plugin marketplace add ./`, `claude plugin install fusion-jev@fusion-local --scope user`. [Plugin reference](https://code.claude.com/docs/en/plugins-reference), [MCP setup](https://code.claude.com/docs/en/mcp).

## What it adds

- MCP tools `fusion_inspect`, `fusion_assist` and `fusion_evidence` (default `assist` profile).
- A short SessionStart hint and the `/fusion-jev:assist` skill.
- An **opt-in** PreToolUse hook that auto-wraps noisy commands (below). It is off until you enable it.

## Auto-wrap (opt-in)

```sh
npx -y --package=fusion-jev-mcp fusion-jev config auto-wrap on    # or set FUSION_AUTO_WRAP=1
npx -y --package=fusion-jev-mcp fusion-jev config auto-wrap status
npx -y --package=fusion-jev-mcp fusion-jev config auto-wrap off
```

When on, the hook rewrites only **simple** commands (plain words, with no quotes, variables, pipes, redirects, chaining or globs) that match a noisy allowlist: `npm test`, `npm run build|lint|typecheck|check`, `pnpm`/`yarn` equivalents, `npx tsc|jest|vitest run|eslint`, `pytest`, `cargo build|test|check|clippy`, `go test|build|vet`, `make`, `mvn`, `gradle`, `dotnet build|test`. They become `fusion-jev run -- <command>`, using a `fusion-jev` binary on PATH if present and the pinned `npx` package otherwise. Claude receives the exit status, a compact diagnostic and receipts; `fusion_evidence` or `fusion-jev evidence ID --raw` recovers the captured bytes.

The hook never sets a permission decision, so Claude Code's normal permission flow applies to the rewritten command. If you pre-approve commands such as `Bash(npm test:*)`, also allow `Bash(fusion-jev run:*)` (or the `npx … fusion-jev run` form) to avoid new prompts. Anything the hook does not recognize passes through unchanged.

## Configuration and boundaries

Save a trusted private provider file with `fusion-jev config env-file ABSOLUTE_PATH`; `TYPESAFE_API_KEY` enables optional official Jev. Deterministic tools work without it, and `fusion-jev doctor stdio` makes no network request. Claude keeps reasoning, edits, execution authorization and correctness. Host escalation requires no Anthropic or OpenAI API key. Installing this adapter does not remove or alter unrelated skills, hooks, instruction files or plugins.
