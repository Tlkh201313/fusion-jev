# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Renamed the npm package from `fusion-jev-mcp` to `fusion-jev`, and the Claude Code marketplace from `fusion-local` to `fusion-jev`. The binary is `fusion-jev`; the on-disk configuration and evidence directory name stays `fusion-jev-mcp`.
- Claude Code and Codex plugins now launch the server with `npx -y fusion-jev stdio`, so no prior global install is needed.
- Rewrote the README around a quick install, a before/after example, a how-it-works diagram, a glossary, an FAQ and a single consolidated Limits section.

- Plugin launches are pinned to the package version (`npx -y fusion-jev@<version> stdio`), kept in sync by `scripts/sync-version.mjs` (run by `npm version`); the release workflow now fails on a tag/version mismatch.
- Host guidance and the CLI recovery lines now use `npx -y fusion-jev ...`, which works without a global install. The `recover*Argv` lines are unchanged.
- The registry name and `mcpName` are now `io.github.Tlkh201313/fusion-jev` to match the GitHub login case; the registry compares namespaces case-sensitively.

### Added

- Native Windows `npx` troubleshooting and a README sample taken from real CLI output.
- Documentation: install guide for every host (including Codex `config.toml` and Windows notes), how-it-works, FAQ, docs index and an examples README.
- `benchmark/real-host.md`: a method and empty results template for measuring real hosts.
- Community files: Code of Conduct, feature-request issue template, issue template config, expanded contributing guide and a shorter pull request checklist.
- A release workflow for publishing tagged versions to npm.

### Removed

- Internal planning documents moved out of the public docs; legacy provider notes removed from user-facing docs.

## [0.3.0] - prepared local source release

### Added

- Official TypeSafe Jev defaults with `TYPESAFE_API_KEY`, a documented `JEV_API_KEY` alias and guarded provider origin and redirect handling.
- Separate public `fusion-jev` command with its own `fusion-jev-mcp` config and evidence namespace; existing private installations are preserved.
- Non-destructive private setup, dry-run connection guidance, and a keyless local doctor that reports optional provider status separately.
- Local Codex and Claude Code adapters, reproducible keyless checks and benchmark material.
