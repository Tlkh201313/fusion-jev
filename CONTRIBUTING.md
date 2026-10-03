# Contributing

Thanks for helping. Please read the [Code of Conduct](https://github.com/Tlkh201313/fusion-jev/blob/main/CODE_OF_CONDUCT.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## Setup

You need Node 22.12+ and npm.

```sh
git clone https://github.com/Tlkh201313/fusion-jev.git
cd fusion-jev
npm ci
npm run build
```

`npm run setup` builds and prints host connection commands that use absolute paths to your checkout, so you can try your changes in Claude Code or Codex. See [docs/install.md](docs/install.md).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run check` | Typecheck, run tests, then build. Run this before every PR. |
| `npm run typecheck` | Type-check without emitting. |
| `npm test` | Run the test suite serially, with provider credentials cleared. |
| `npm run build` | Compile to `dist/`. |
| `npm run demo` | Keyless scripted routing example (`examples/workflow.ts`). |
| `npm run benchmark` | Offline routing benchmark with simulated providers. |
| `npm run benchmark:workspace` / `:overview` / `:workflows` | Offline workspace, overview and workflow benchmarks. |
| `npm run benchmark:support` | Output-handling benchmark; `-- --corpus=noisy` compares real RTK compression, `-- --corpus=120` generates 120 parser cases. |
| `npm run benchmark:live` | Billable live-provider run; needs `FUSION_LIVE_BENCHMARK=1` and keys. Never enable in CI. |
| `npm run pack:smoke` | Pack the tarball and exercise it from a clean consumer directory. |
| `npm run pack:check` | `npm pack --dry-run` to list package contents. |
| `npm run version:check` | Verify `server.json`, plugin manifests and plugin pins match `package.json`. |
| `npm run doctor` | Local readiness check from the checkout. |

## Tests

- Add a failing regression test before changing behavior, then make it pass.
- Tests live in `test/*.test.ts` and run with the Node test runner through `tsx`. The runner clears all supported provider key names and runs serially, so tests never call a paid provider.
- Use fake credentials and isolated cache/config directories. Do not commit transcripts, API keys, captured sensitive evidence or local skill backups.
- Windows, Linux and macOS are covered by CI. Evidence file permissions and process cleanup behave differently on Windows, so changes there deserve a native Windows run.
- Validate the Claude plugin and marketplace with `claude plugin validate ... --strict` when you change them. Keep the Codex and Claude manifests separate; they use different schemas.

## Design rules

- Jev may select validated candidate IDs only; it never generates code, executable arguments or outcome claims.
- Keep the small `assist` profile and the `full` compatibility profile.
- Commands run only through the host's authorization. Discovered scripts are untrusted data.
- Keep diagnostic bytes, source ranges and omissions recoverable.

## Pull request checklist

- [ ] `npm run check` passes.
- [ ] `npm run pack:smoke` passes.
- [ ] A regression test fails without the change and passes with it.
- [ ] Docs and `CHANGELOG.md` (`[Unreleased]`) are updated for user-visible changes.
- [ ] Output or performance changes include the numbers below.

## Where to add benchmarks

- Offline benchmarks live in `benchmark/`. Add fixtures to `benchmark/support-fixtures.ts` for output-handling cases, or workloads to `benchmark/workflows.ts`, and run them through the matching `npm run benchmark:*` script.
- For output or performance changes, report the same workload before and after: emitted payload bytes, expansion bytes, local latency and recovery assertions. Offline bytes/4 estimates and local latency do not establish paid host cost or end-to-end quality.
- Real-host measurements follow the method in [benchmark/real-host.md](https://github.com/Tlkh201313/fusion-jev/blob/main/benchmark/real-host.md).

## Releasing

Maintainers only. The version lives in `package.json`; `scripts/sync-version.mjs` copies it into `server.json` (both `version` fields), the three plugin manifests, the `fusion-jev@<version>` pin in both plugin `.mcp.json` files and the server version in `src/mcp.ts`. `npm run version:check` verifies they agree, and `test/plugin.test.ts` asserts it.

1. Move the `[Unreleased]` changelog entries under the new version.
2. Run `npm version <patch|minor|major|x.y.z>` on a clean `main`. npm bumps `package.json` and the lockfile, runs the `version` script (the sync script, then `git add` for the files it changed), commits and creates the `vX.Y.Z` tag.
3. Push the commit and the tag (`git push --follow-tags`). The release workflow first fails unless the tag (without the `v`), `package.json`, `server.json` and the plugin pins all agree, then runs `npm run check`, `npm run pack:smoke` and `npm publish --provenance --access public` (needs the `NPM_TOKEN` secret).
4. After the package is on npm, publish the registry entry by hand; the workflow does not do this. Install [`mcp-publisher`](https://modelcontextprotocol.io/registry/quickstart), then from the repository root:

   ```sh
   mcp-publisher login github     # device-code flow in your browser
   mcp-publisher publish          # publishes ./server.json
   ```

   The registry requires `server.json`'s `name` to equal `mcpName` in `package.json` and, for GitHub login, to start with `io.github.<your GitHub login>/`. The registry source builds that namespace from your GitHub login exactly as GitHub returns it and compares it case-sensitively, which is why the name is `io.github.Tlkh201313/fusion-jev`.

This is a community project and is not an official TypeSafe product.
