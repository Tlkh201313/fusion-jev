# Set up Fusion Jev with your own coding agent

Copy the prompt below into Claude Code, Codex, or another coding agent you control. It asks for a short plan before installation or configuration changes. No API key is needed. Choose an empty disposable folder for the first trial.

The public npm package checked on 3 October 2026 is `fusion-jev@0.3.0`. Its registry `gitHead` is `5dfdd2495e14590dab7412132b4f341f8df2c8fe`; newer source can use the same version label, so a version number alone does not prove which fixes are included. This is an early-release trial, not a guarantee of production readiness.

## Copy-paste prompt

```text
Help me safely try Fusion Jev, a local CLI/MCP server for compact command results and short-lived receipts. Start with a disposable folder and no provider credentials. The public integration is for official TypeSafe Jev; do not import a maintainer's private router, endpoint, files or personal configuration. Do not change my project code.

1. Preflight, read-only first
- Identify the actual OS, architecture and shell, including native Windows versus WSL. Record Node/npm and my coding-host versions using their supported commands. Fusion needs Node >=22.12.0. Ask which host I want if it is unclear.
- Ask for the disposable project root if none is selected. Keep its exact canonical path local; do not post it externally. Inspect only the relevant existing Fusion MCP/plugin entries, and summarize whether one already exists. Never dump complete host configuration, environment variables, credential files or npm authentication settings.
- Check public metadata with:
  npm view fusion-jev@0.3.0 name version repository.url engines bin dist.integrity --json --registry=https://registry.npmjs.org
  npm view fusion-jev version --registry=https://registry.npmjs.org
- Expect package fusion-jev, repository git+https://github.com/Tlkh201313/fusion-jev.git, binary fusion-jev, and Node >=22.12.0. Report the exact available version and metadata identity. If the package is missing, unreachable, or identity differs, stop installation and explain the observed result. Do not substitute a similarly named package, GitHub branch or mirror.
- Read https://github.com/Tlkh201313/fusion-jev and the exact-version registry metadata. Separate published artifact facts from newer PR/source behavior. Do not promise unpublished fixes, zero bugs, universal savings or an installation time.

2. Show me a short plan and wait for my approval
- Recommend one route: a pinned npx trial, or a global npm install with a pinned exact version if I want repeat CLI use/absolute paths. Explain downloads, npm lifecycle/native dependency execution, likely better-sqlite3 prerequisites, and the config file/scope to be changed.
- Verify the actual resolved executable/package path after installation, not just a global version listing. A host can run a different npx or source copy.
- Prefer MCP-only initially. Do not add both plugin and direct MCP registrations. If an entry exists, show a redacted focused diff and ask before replacing it. Preserve unrelated entries and make a local backup before edits. Do not enable marketplace auto-updates.
- Keep optional Jev disabled for this first trial. If I separately ask to connect my existing official Jev account, use only my own trusted local TypeSafe configuration, official endpoint/model defaults, and explain which data a live request would send before asking approval. Never copy private router configuration. Do not ask me to paste keys into chat, read secret values, enable HTTP hosting/OAuth, modify permissions, broaden workspace roots, install system build tools, use sudo/admin, or disable host approvals. Ask separately if any such step is genuinely necessary.
- Installing Node/npm, a host, Python or C++ tooling is a separate decision. Do not install missing system software automatically. Do not run an untrusted curl-to-shell installer.

3. After approval, install only what we agreed
- Pin the reviewed version. For the current published trial use fusion-jev@0.3.0, not an unpinned package and not fusion-jev-mcp.
- For an npx trial, commands begin npx -y fusion-jev@0.3.0. For an approved global installation, run npm install -g fusion-jev@0.3.0 and inspect npm ls -g fusion-jev --depth=0. There is currently no supported fusion-jev --version or fusion-jev update command.
- Run the approved package's --help and doctor stdio. Doctor is local and does not validate TypeSafe connectivity. An optional-provider-missing warning is expected; liveConnectivity remains not-tested.
- setup --dry-run previews paths and connection commands without creating setup files. Do not run ordinary setup unless we approved creating the private config/provider template. Published 0.3.0 setup uses absolute paths even from npx, which may point into a disposable npm cache; do not save those cache paths as a durable server entry. A global install or stable source checkout is needed for durable absolute paths.
- On native Windows, npx.cmd may fail when launched without a shell. Prefer an approved global install and the absolute node.exe/CLI paths from setup --dry-run. Treat cmd /c as a reported Claude workaround, not verified Codex compatibility. Use shell-appropriate quoting. Do not bypass privacy/ACL failures.

4. Prove CLI behavior with synthetic output only
Run in the disposable folder:
  npx -y fusion-jev@0.3.0 run '--' node -e "for (let i=0;i<200;i++) console.log('unchanged context '+i); console.error('src/example.ts:4:2 - error TS2322: fixture failure'); process.exitCode=2"
If we installed globally, the same arguments can follow fusion-jev instead.
- This intentionally exits 2. Confirm that exit code and the TS2322 diagnostic. Do not treat the synthetic failure as broken installation.
- Copy the complete recoverStdout command from this run and execute it promptly, without rerunning the original fixture. Confirm retained output includes the synthetic lines. Never use an example, invented or abbreviated receipt ID.
- Report redaction/capture flags and any expiry, eviction, missing or stale result. CLI evidence --raw follows pages and prints all retained bytes from the selected start offset. JSON/MCP recovery returns a page; follow nextByte for larger captures. Neither recovers uncaptured or redacted bytes. Recovery has a ten-minute lifetime and may be evicted earlier.

5. Connect only the chosen host and scope
- Confirm current host help supports the planned syntax. For Claude Code, the basic pinned entry is:
  claude mcp add --transport stdio --scope local fusion-jev -- npx -y fusion-jev@0.3.0 stdio
- For Codex, the basic pinned entry is:
  codex mcp add fusion-jev -- npx -y fusion-jev@0.3.0 stdio
  Or edit only the approved [mcp_servers.fusion-jev] table in the approved config.toml with command="npx" and args=["-y","fusion-jev@0.3.0","stdio"].
- If using a global installation/Windows absolute paths, use the approved paths instead of npx. Verify they exist outside a temporary cache.
- Limit FUSION_WORKSPACE_ROOT to the disposable project's exact canonical root. No extra allowed roots. Add only this non-secret setting if needed; never forward my full environment or NODE_OPTIONS automatically.
- Restart/reconnect only as needed. Inspect /mcp or the host's supported server-list command. Then invoke fusion_inspect to read up to 20 lines of a non-sensitive text file in that folder. If there is no suitable file, ask before creating a tiny fixture. Show the actual tool invocation and whether the content was returned. A registered entry alone is not proof of activation.
- The default profile should expose fusion_inspect, fusion_assist and fusion_evidence. Tests/builds use the CLI via the host's normal command tool, not an invented MCP shell tool.

6. Finish with a concise, redacted report and rollback instructions
- State installed package/version, artifact identity if available, host/OS/shell versions, route/config scope, doctor result, actual MCP invocation, fixture exit status and receipt recovery result. Distinguish verified, failed and not tested.
- Show how to remove only this server/plugin and, if global, npm uninstall -g fusion-jev. For Claude's local entry use claude mcp remove fusion-jev --scope local. For Codex inspect codex mcp --help or remove only the exact approved table and child tables. Preserve unrelated config.
- Do not delete receipts, provider files, backups or caches automatically. Offer focused cleanup with resolved paths and ask before deletion.
- Explain updates: check metadata/release notes, deliberately install a reviewed new exact version, update this host's pin, reconnect and repeat fixture/recovery. A global update does not change an npx/plugin pin. Do not auto-update or fabricate an outdated notice.
- Stop after the agreed trial. Do not run real project tests, upload logs, publish packages, enable providers, or make unrelated changes without a new request.
```

## Success means

A recorded exact version, a local doctor result, the expected synthetic exit code, recovery from that same run, and a visibly successful host tool call. Missing any of these is an incomplete trial, not a reason to disable safety checks.
