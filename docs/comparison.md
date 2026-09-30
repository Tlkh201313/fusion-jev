# Scope comparison and adoption examples

Documentation checked on **2026-09-30**. This is a comparison of product scope, not a claim of performance superiority. Use [setup](../README.md) to try Fusion Jev and [market fit](market-fit.md) to understand the intended jobs.

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

Sources: [RTK](https://github.com/rtk-ai/rtk), [Context7](https://github.com/upstash/context7), [Claude-mem](https://github.com/thedotmack/claude-mem), [Superpowers](https://github.com/obra/superpowers). Native and Fusion entries describe implementation boundaries, not independently measured comparative outcomes.

RTK's current README documents sqlite recall, failure-output recovery, Windows setup, Codex rewriting, analytics and removal. Its [v0.50.0 release](https://github.com/rtk-ai/rtk/releases/tag/v0.50.0) includes recovery, stderr and argument-handling fixes. Compare current versions and actual paths. Fusion Jev must not be promoted as the first recoverable compressor or as universally safer or faster.

## Four projects above 1,000 stars

Exact public GitHub star counts were read from the linked repository APIs on **2026-09-30**. They measure a snapshot of attention, not active users, retention, revenue or causal acquisition. Repository materials show how products are presented and distributed; they cannot establish which activities caused growth.

| Project | Verified stars | Observed packaging and distribution | Release/developer practice to learn from |
|---|---:|---|---|
| [RTK](https://github.com/rtk-ai/rtk); [API](https://api.github.com/repos/rtk-ai/rtk) | 82,107 | README leads with a concrete command-output problem, commands, package-manager installation, per-host initialization, translations, analytics and troubleshooting. | [v0.50.0](https://github.com/rtk-ai/rtk/releases/tag/v0.50.0), 2026-09-24, ties recovery and compatibility changes to commits. Maintain a fixture for reported output failures; show overhead and removal. |
| [Superpowers](https://github.com/obra/superpowers); [API](https://api.github.com/repos/obra/superpowers) | 293,408 | README packages a recognizable workflow into skills, provides Claude/Codex marketplace paths, community support and release signup. | [v6.4.2](https://github.com/obra/superpowers/releases/tag/v6.4.2), 2026-09-25, relates a planning change to a user report and specific probes. Explain the trigger, changed behavior and verification. Release-specific measurements do not generalize to Fusion. |
| [Context7](https://github.com/upstash/context7); [API](https://api.github.com/repos/upstash/context7) | 62,566 | README names outdated documentation as the pain, shows short prompts, single-command setup/removal, CLI/skills or MCP modes, client docs, translations and media links. | [Releases](https://github.com/upstash/context7/releases) version CLI, MCP and SDK components separately; SDK 0.5.0 on 2026-09-22 adds direct search. Separate user setup from contributor instructions. Its backend/parser/crawler are private. Media links show content exists, not acquisition effectiveness. |
| [Claude-mem](https://github.com/thedotmack/claude-mem); [API](https://api.github.com/repos/thedotmack/claude-mem) | 95,015 | README offers persistent memory, installer/plugin routes, animated preview, translations and staged index-to-detail retrieval. | [v13.28.0](https://github.com/thedotmack/claude-mem/releases/tag/v13.28.0), 2026-09-26, fixes noninteractive installation and explains saved providers, optional signup and privacy. Make installer failures reproducible and document network/account choices. Its AI memory differs from exact command capture. |

The transferable pattern is a narrow recognizable job, low-friction setup, visible first success, host-native distribution, accessible troubleshooting and releases responding to real failures. These are recommendations informed by observed practice, not a formula for obtaining stars. Do not copy unverified savings claims from a project's marketing.

## Evidence to publish with comparisons

Record version, OS, host, command, workload and run order. Include native/current RTK/Fusion output, answer-required expansion, captured-byte verification, exit classification, cold/warm startup and p50/p95 task timing. Report actual host token usage separately from serialized bytes or bytes/4 estimates. Include optional provider prices and usage only when known; unknown costs stay unknown.

Synthetic command fixtures can test output handling. They do not establish equal task quality or reduced subscription usage. Label a missing comparator unavailable instead of treating it as a win. Keep small-result and latency regressions visible. See the [pilot and evidence gates](launch-plan.md).
