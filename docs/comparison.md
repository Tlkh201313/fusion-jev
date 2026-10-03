# Comparison

Documentation checked on **2026-09-30**. This compares product scope, not performance. Tools in this space overlap and often work together; check each project's current README before deciding.

## Scope

| Need | Native host tools | RTK | Fusion Jev | Context7 | Claude-mem / Superpowers |
|---|---|---|---|---|---|
| Compact noisy command output | Host-specific output budgets | Main product; many command filters | Compact results with explicit raw mode | Documentation retrieval | Different focus |
| Recover captured original command output | Host/session-dependent | Recall/tee already available | Evidence IDs and expansion, bounded by capture limits and expiry | Sourced documentation, not command capture | Memory summaries or workflow instructions, not equivalent command receipts |
| Current library documentation | Host browsing/tools | Can compact underlying commands | Host retains browsing and research | Main product | Complementary tools |
| Structured development methodology | Host instructions/skills | Does not establish one | Host retains its methodology | Documentation lookup guidance | Superpowers provides skills and workflows |
| Persistent semantic session memory | Host-specific | Command recovery, not semantic project memory | Captured evidence, not semantic project memory | Documentation service | Claude-mem provides cross-session memory |
| Additional provider/service | Host's model/services | Filtering requires no model | Deterministic path needs no key; TypeSafe decisions optional | Hosted documentation service | Claude-mem offers providers; Superpowers uses host agents |
| Setup | Already installed | Binary/package manager plus host integration | Node runtime/package and optional host adapter | CLI/skills or MCP setup | Plugin/installer, depending on project |

Sources: [RTK](https://github.com/rtk-ai/rtk), [Context7](https://github.com/upstash/context7), [Claude-mem](https://github.com/thedotmack/claude-mem), [Superpowers](https://github.com/obra/superpowers). Native and Fusion entries describe implementation boundaries, not independently measured outcomes.

RTK's README documents sqlite recall, failure-output recovery, Windows setup, Codex rewriting, analytics and removal, so recoverable compression is not unique to Fusion Jev. Fusion Jev's angle is MCP tools plus receipts for the exact captured output and bounded repository inspections. Compare current versions on your own workflow.

## When Fusion Jev fits

- You diagnose noisy test or build output and want the failure plus a way to get the full log back without rerunning.
- You use Claude Code or Codex and want one small MCP server that works without an account.
- You want explicit limits (capture size, expiry, redaction) reported rather than silent clipping.

It fits less well if native tools or RTK already cover your workflow, or if you mostly produce tiny outputs: those (1 KiB or less) pass through verbatim with one status line, so there is nothing to compact.

## Measuring for yourself

Record version, OS, host, command, workload and run order. Report what the host actually receives, not just serialized bytes or bytes/4 estimates. Label a missing comparator unavailable instead of counting it as a win, and keep small-result and latency regressions visible. Synthetic fixtures test output handling; they do not establish equal task quality or lower subscription usage. A template lives in [benchmark/real-host.md](https://github.com/Tlkh201313/fusion-jev/blob/main/benchmark/real-host.md).
