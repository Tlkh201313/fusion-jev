# Who Fusion Jev is for

Fusion Jev is a local evidence layer for Codex and Claude Code: compact noisy command results and repository inspections, disclose capture limits, and recover the captured original evidence when needed. The host keeps reasoning, editing, execution authorization and correctness decisions. Optional TypeSafe Jev decisions select between validated bounded actions; known reads remain deterministic. Fusion Jev is an independent community integration, not an official TypeSafe product. See [installation and usage](../README.md) and [host adapters](setup.md).

## Initial audience

| User | Job and pain | Fit and limit |
|---|---|---|
| Developer diagnosing noisy tests or builds | Needs the failure and useful tail without hundreds of passing lines | Compact diagnostics, exit classification and captured-output expansion. Small outputs can become larger with receipt overhead. |
| Developer reviewing Git changes or performing a scoped refactor | Needs to know which files, hunks and matches were covered | Explicit clipping and staged/unstaged scopes. A compact result is insufficient to claim complete review without checking coverage. |
| Long-session user repeating commands after compaction | Needs a reliable way to retrieve earlier results | Evidence IDs recover captures without rerunning commands. The plugin cannot control host compaction or guarantee that the host retains every reference. |
| Maintainer supporting both coding hosts | Needs one runtime, clean configuration and visible activation | Local core plus separate host-native adapters. Plugin availability does not force host use. |

Short tasks with tiny outputs may benefit less. Users satisfied with native tools or RTK should compare actual workflows before adding another component. Fusion Jev does not replace a coding agent or provide semantic cross-session project memory.

## Evidence of demand

The following public GitHub issue bodies and states were checked on **2026-09-30**. They are user reports and requests, not defects independently reproduced here. They establish individual pain, not market size or willingness to pay.

| Primary report | Opened; state when checked | Relevant lesson |
|---|---|---|
| [RTK #4098](https://github.com/rtk-ai/rtk/issues/4098): flat-list cap without recovery | 2026-09-17; open | Reporter using RTK 0.49.0 distinguishes a broken cap from the working `rg` recall path. Every omission needs a count or explicit unknown and a usable recovery instruction. Do not generalize the report to all RTK commands. |
| [RTK #1313](https://github.com/rtk-ai/rtk/issues/1313): lossless-only mode request | 2026-04-14; open | Users distinguish reformatting from removal of information. A compact summary is not itself the captured original. |
| [RTK #620](https://github.com/rtk-ai/rtk/issues/620): parser fallback clips failures | 2026-03-16; closed | Historical report describes clipped diagnostics and repeated commands. Preserve exit status and usable diagnostics on parser failure; its closed state matters. |
| [Codex #37121](https://github.com/openai/codex/issues/37121): recoverable state lost after truncation and compaction | 2026-08-05; open | Storing results alone is insufficient; recovery handles and continuation instructions must be usable in the host workflow. |
| [Codex #38135](https://github.com/openai/codex/issues/38135): hook output replacement request | 2026-08-12; open | Appending a compressed copy beside original output can enlarge context. Count what the host actually receives and avoid universal interception claims. |
| [Claude Code #31279](https://github.com/anthropics/claude-code/issues/31279): large-output transformation request | 2026-03-05; closed as not planned | Gives test, build and review examples. Demonstrates demand, not availability of the proposed hook. |
| [Superpowers #743](https://github.com/obra/superpowers/issues/743): reported slower responses | 2026-03-15; open | The reporter hypothesizes skill-context overhead; this is not a measured cause. Show actual overhead and keep adapter instructions focused. |
| [Superpowers #446](https://github.com/obra/superpowers/issues/446): how to recognize invocation | 2026-02-09; closed | Installation should have a visible activation check and first useful result. |

## What must be demonstrated

The market is crowded: RTK already offers output compression and recall, while Claude-mem uses progressive disclosure for memory. Fusion Jev's opportunity is to demonstrate consistent evidence handling across supported captures, a small MCP footprint and simple setup. This is a product hypothesis, not a unique-category claim. See [comparison and project examples](comparison.md).

Measure matched native tools, current RTK, deterministic Fusion Jev and optional Jev decisions. Include expansions required to answer the task, retries, unsupported outputs, small results and slow startup cases. Report capture limits, expired receipts, redaction and missing comparators explicitly.

Exact recovery means recovery of what was captured under the stated limits. The command itself can produce incomplete data; capture can be clipped or redacted; receipts expire. Neither a byte-reduction percentage nor a provider probability proves correctness, lower bills or faster tasks. Real-host quality, cost and latency require paired observations. No fixed savings or 99.99% accuracy guarantee is established.

## Near-term priorities

1. A credential-free first useful result: noisy failure, compact diagnostic and captured-output expansion.
2. Independently installable runtime and adapters with clean configuration, isolated evidence storage and reversible removal.
3. Offline doctor distinguishing deterministic readiness, optional provider configuration and untested live connectivity.
4. Raw output when useful, explicit capture/expiry boundaries and preserved child exit status.
5. Representative host traces and user-reported defects before broad performance marketing.

The [launch plan](launch-plan.md) turns these priorities into a measured pilot and release process.
