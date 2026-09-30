# Twelve-week launch plan

Fusion Jev's initial audience is local Codex and Claude Code developers who diagnose noisy checks or need traceable inspection results. The goal is repeat useful use with dependable recovery and easy setup. Stars are a secondary attention measure. See [market fit](market-fit.md), [comparison](comparison.md) and [technical setup](../README.md).

This is a prospective plan. It does not imply that a public repository/package exists, a demo has been recorded, people have been contacted, hosts have approved a listing or any publishing has occurred. The package name `fusion-jev-mcp` is provisional until ownership and publication are verified; use the tested source installation documented in the README until released artifacts exist.

## Weeks 1–2: validate the first useful result

Recruit **5–10 opt-in pilot users** when outreach is authorized. Prioritize people already running noisy tests/builds or reviewing large diffs in either supported host. Ask each to install, run one noisy failing command, expand its capture, try one small result, and repeat a useful task on another day. Include Windows and Linux; track results separately for Codex and Claude Code.

Deliver a credential-free failure fixture, offline doctor, actual host setup and removal instructions, an evidence-retention explanation and a short issue template. Known inspection should work without a TypeSafe account. Provider configuration must be explicit and separate from plugin manifests; current CLI provider-file syntax is `--provider-env=ABSOLUTE_PATH`, as documented in setup. Doctor readiness validates local configuration, not live credentials.

**Demo TODO:** record a real 45–60 second run showing the deliberate failure, useful compact diagnostic, evidence expansion and exit status. Record host activation separately if it does not fit clearly. Do not label a scripted routing demo as a real model-quality measurement. No recording is claimed here.

Pilot targets to evaluate, not promised results:

- At least 8 of 10 participants can reach a useful result using written setup alone; adjust the denominator honestly if fewer participate.
- Every participant can identify whether Fusion Jev was actually invoked.
- All sampled supported, retained captures expand correctly; clipping, redaction and expiry are visible.
- At least half repeat a useful task on a separate day within two weeks.
- No unauthorized execution or silent evidence loss in observed supported workflows. A failure blocks expansion until understood and fixed; zero observed failures is not a population guarantee.

## Weeks 3–4: repair setup and publish reproducible evidence

Turn pilot defects into regression fixtures. Fix high-impact setup, parsing, recovery and activation issues before adding features. Publish a capability matrix covering supported results, raw behavior, capture limits, retention and host boundaries.

Run matched native/current RTK/deterministic Fusion/optional Jev tasks: noisy failure, small output, staged/unstaged Git inspection, paginated search and cross-process evidence expansion. Count required expansion and retries. Separate bytes from actual host tokens, priced provider calls and end-to-end latency. Save raw reports with version and reproduction command. If public artifacts are ready and publication is authorized, ship a small release with a concise changed-behavior example and known limits.

## Weeks 5–6: distribute where the users already work

After install reliability is demonstrated, prepare native Codex/Claude plugin listings using the hosts' actual submission rules. Listings are proposals until accepted. Keep the same core version and isolated configuration/evidence namespace in both adapters. Avoid duplicate MCP connections and modifications to unrelated tools or skills.

Prepare a project-owned GitHub release/discussion and a concise factual demo for relevant coding-agent communities. Explain the job, setup, what remains with the host, and where comparison artifacts live. Outreach, posts and submissions require authorization; this plan sends nothing. Do not advertise inside unrelated issue threads or imply endorsement by TypeSafe, OpenAI or Anthropic.

## Weeks 7–8: improve retention around observed jobs

Review repeated-use patterns and support burden. Prioritize the command types users repeatedly need and cases that cause re-reading or rerunning. Keep deterministic known inspections fast and the tool surface small. Add a formatter only with a meaningful fixture and usable original-output recovery.

Provide contribution instructions for adding one fixture/formatter, supported-host troubleshooting and a release-candidate channel only if there is capacity to support it. Compare retention by actual job and host; a star or install without a useful result is not activation.

## Weeks 9–10: test optional Jev's incremental value

Evaluate bounded action selection independently from deterministic output compression. Use the official [TypeSafe API](https://docs.typesafe.ai/api) and disclose billable calls. Compare the same ambiguous tasks with host-only/deterministic choices; include abstentions, provider errors, invalid choices, action coverage, cost and latency.

No optional provider path should be required for the deterministic first success. A probability does not establish calibration on these tasks. Retain host reasoning and authorization, and avoid introducing selection calls into obvious reads. Ship only changes supported by measured task benefit or a clear user need.

## Weeks 11–12: decide what to expand

Publish an honest pilot summary: cohort size, activation, repeat use, supported task completion, recovery failures, quality evaluation and measured costs/timing. Include negative results and missing data. Decide whether to improve the existing wedge, support another demanded output type or postpone expansion.

Interview retained users about the value and willingness to pay before proposing hosted/team features. Repository attention does not establish a commercial market. Do not add remote hosting or a broad agent methodology merely to increase feature count.

## Metrics and evidence gates

| Measure | Definition | Evidence needed before a claim |
|---|---|---|
| Activation | New participant completes a useful compact-result and recovery task | Observed setup completion and host invocation, by OS/host |
| Retention | Activated participant repeats a useful job on a separate day | Opt-in aggregate repeat counts, cohort and observation window |
| Recovery quality | Captured supported output expands within documented retention/bounds | Byte comparisons and explicit overflow/redaction/expiry cases |
| Task quality | Host reaches a correct supported outcome without missing required facts | Matched tasks, review criteria, evaluated failures; no “99.99%” inference from a small corpus |
| Context | What the host actually receives, including required expansion/retries | Host token usage where available; bytes separately, estimates labeled |
| Cost | Provider and host costs that can actually be measured | Dated prices/usage; unknown subscription allocation remains unknown |
| Latency | End-to-end task duration and cold/warm startup | Repeated paired runs, median and p95, platform separation |

Before making a general benefit claim, require correct supported-task outcomes, usable recovery, no unresolved unauthorized execution or silent-loss defect, and representative paired host observations. Proposed improvement targets may be written as targets, but remain unverified until measured. A byte-reduction fixture cannot justify a bill-reduction or faster-agent claim. There is no established universal savings or 99.99% correctness guarantee.

Collect only opt-in aggregate results initially. Keep source, prompts, credentials and command arguments out of analytics. User reports can include sanitized fixtures; private logs must not be a default requirement.

## Issue-to-release workflow

1. Issue template asks host, OS, runtime/core/adapter versions, output category, expected/observed recovery and a sanitized minimal reproduction.
2. Triage installation, permissions, capture/recovery, formatting, provider and host-specific behavior separately.
3. Reproduce the supported failure and retain a regression fixture before fixing it.
4. Verify the relevant behavior, clean package installation/removal and both affected adapters.
5. Release notes lead with the trigger and changed behavior, link the issue/fix and describe known limits. Update troubleshooting beside setup.
6. Request verification from the reporter only when messaging is authorized. Keep releases small enough that users can identify the improvement.

This practice is visible in [RTK v0.50.0](https://github.com/rtk-ai/rtk/releases/tag/v0.50.0), [Superpowers v6.4.2](https://github.com/obra/superpowers/releases/tag/v6.4.2), [Claude-mem v13.28.0](https://github.com/thedotmack/claude-mem/releases/tag/v13.28.0) and [Context7's component releases](https://github.com/upstash/context7/releases). These examples inform the process; they do not prove its causal effect on adoption.

## Release facts still to verify

Owned repository URL and publisher identity; npm package availability/name ownership; release tag and published artifacts; clean-install/host compatibility results; accepted marketplace listings; recorded demo; representative host quality/cost/latency results; pilot participation and retention. Do not invent these facts in launch copy.
