# Changelog

## 0.3.1 — installable, hardened

- One-command install: plugin manifests launch the pinned package with `npx`, and evidence storage uses the built-in `node:sqlite` (Node 22.13+), so installation needs no native build.
- Security: linear-time redaction with common token shapes, a wider credential-file denylist, repository filter drivers neutralized during Git inspection, a flat `fusion_evidence` schema, and profile-hidden tools that cannot be called.
- Command wrapper: forwarded signals with a grace period, no hang on pipe-holding descendants, EPIPE-safe raw relay, child status kept when storage fails, 128+signal exit codes.
- Tag-triggered npm publish workflow with provenance.

## 0.3.0 — prepared local source release

- Official TypeSafe Jev defaults with `TYPESAFE_API_KEY`, a documented `JEV_API_KEY` alias and guarded provider origin/redirect handling.
- Separate public `fusion-jev` command and `fusion-jev-mcp` config/evidence namespace; existing private installations are preserved.
- Non-destructive private setup, dry-run connection guidance, and keyless local doctor readiness with optional provider status reported separately.
- Curated open source distribution, local Codex/Claude adapters, reproducible keyless checks and candid product evaluation material.

The package name is provisional and unpublished. Measurements and platform verification should be read from the actual release validation record; this changelog makes no general speed, quality or cost guarantee.
