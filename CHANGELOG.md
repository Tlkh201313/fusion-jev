# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Renamed the npm package from `fusion-jev-mcp` to `fusion-jev`, and the Claude Code marketplace from `fusion-local` to `fusion-jev`. The binary is `fusion-jev`; the on-disk configuration and evidence directory name stays `fusion-jev-mcp`. Existing `fusion-jev@fusion-local` installs do not update across the rename: run `/plugin uninstall fusion-jev@fusion-local`, then add this marketplace and `/plugin install fusion-jev@fusion-jev`.
- Claude Code and Codex plugins now launch the server with `npx -y fusion-jev stdio`, so no prior global install is needed.
- Rewrote the README around a quick install, a before/after example, a how-it-works diagram, a glossary, an FAQ and a single consolidated Limits section.

- Plugin launches are pinned to the package version (`npx -y fusion-jev@<version> stdio`), kept in sync by `scripts/sync-version.mjs` (run by `npm version`); the release workflow now fails on a tag/version mismatch.
- Host guidance now uses `npx -y fusion-jev ...`, which works without a global install. CLI recovery lines name the copy that wrote the receipt: `npx -y fusion-jev@<version> evidence ID --raw` when run from the npx cache, `fusion-jev evidence ID --raw` when the command is on `PATH`, otherwise a `recover*Argv=[...]` line.
- The registry name and `mcpName` are now `io.github.Tlkh201313/fusion-jev` to match the GitHub login case; the registry compares namespaces case-sensitively.
- `fusion-jev run` passes small output through: when both streams total 1 KiB or less, are complete, unredacted and valid UTF-8, the output is printed verbatim followed by one `exitCode=N durationMs=N` line, and no receipt is written.
- Trimmed the compact `run` format. `*Truncated`, `*Redacted` and `cleanupFailed` are printed only when true; `*OriginalBytes` only when it differs from the stored count; `signal=` and `errorCode=` only when set; empty streams get no receipt; zero counters are dropped; and there is one `recoverStdout=` / `recoverStderr=` line per stream whose bytes were not shown. A small stream (1,200 bytes or less, complete, UTF-8) inside a larger result is shown verbatim.
- Lower `run` overhead: lazy imports, capture in memory before opening the private evidence store (only when a receipt is needed), and the Windows process-tree snapshot no longer blocks exit. `node --version` through Fusion now takes about 370 ms median, down from about 5.3 s under the same load.
- The repository overview prioritizes `package.json` entry points.
- `setup` prints pinned `npx -y fusion-jev@<version>` commands when run from the npx cache.

### Added

- Native Windows `npx` troubleshooting and a README sample taken from real CLI output.
- README graphics: hero, before/after and how-it-works diagrams (`docs/assets/`).
- First raw-vs-Fusion results on real commands (`benchmark/raw-vs-fusion.mjs`, `benchmark/results/`): output bytes, timings, exit-code preservation and receipt recovery. They measure tool output only, not host token usage.
- Node 24 `node:test` (spec reporter) failures now yield one diagnostic per failing test.
- Documentation: install guide for every host (including Codex `config.toml` and Windows notes), how-it-works, FAQ, docs index and an examples README.
- `benchmark/real-host.md`: a method and empty results template for measuring real hosts.
- Community files: Code of Conduct, feature-request issue template, issue template config, expanded contributing guide and a shorter pull request checklist.
- A release workflow for publishing tagged versions to npm.

### Fixed

- Fixed workspace Git status/diff executing configured clean/process filters. Inspection now bounds configuration lookup, disables effective clean/smudge/process drivers and required settings, and refuses unsafe filter names or failed lookup. This covers stable configuration; concurrent introduction of a new driver between lookup and execution remains unsupported. Global filters are also bypassed, so results compare raw working-tree contents. Dirty submodule contents are no longer scanned; submodule commit changes remain visible.
- `git log -p` and `git diff` output no longer produces false diagnostics from diff content.

### Removed

- Internal planning documents moved out of the public docs; legacy provider notes removed from user-facing docs.

## [0.3.0] - prepared local source release

### Added

- Official TypeSafe Jev defaults with `TYPESAFE_API_KEY`, a documented `JEV_API_KEY` alias and guarded provider origin and redirect handling.
- Separate public `fusion-jev` command with its own `fusion-jev-mcp` config and evidence namespace; existing private installations are preserved.
- Non-destructive private setup, dry-run connection guidance, and a keyless local doctor that reports optional provider status separately.
- Local Codex and Claude Code adapters, reproducible keyless checks and benchmark material.
