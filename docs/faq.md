# FAQ

## Privacy and cost

**Does it send my code anywhere?**
Local reads, searches, Git inspection and command capture run on your machine, and receipts are stored in a private local directory. If you configure a TypeSafe key, Jev receives only the bounded task text and candidate descriptions Fusion sends it. The CLI's only network destination is the official TypeSafe API, and only when a key is set. Deterministic reads never send repository contents to Jev.

**Do I need a key?**
No. Compact command evidence, `fusion_inspect` and `fusion_evidence` work without one. `fusion_assist` still works; without a key, uncertain choices return to your host. `fusion-jev doctor` reports the provider as missing and exits successfully.

**What does it cost?**
Fusion Jev is free and MIT licensed. If you enable Jev, requests may incur charges from TypeSafe; check their current terms. Cost estimates stay "unknown" unless you set all three `JEV_*_USD_PER_MILLION` values. Escalation uses your current Claude Code or Codex session and needs no Anthropic or OpenAI API key.

**Can secrets end up in a receipt?**
Known credential patterns are redacted before storage, but redaction is pattern matching, not a guarantee. Treat receipts like any other command output on your machine; they expire after 10 minutes. See [Limits](../README.md#limits).

## Comparison

**How is it different from RTK?**
RTK's main product is filtering output across many commands and it has its own recall. Fusion Jev provides MCP tools plus receipts for recovering captured output and bounded repository inspections. Compare both on your workflow before adding another component. See [comparison](comparison.md).

**How is it different from Context7?**
Context7 retrieves current library documentation. Fusion Jev does not; it compacts and recovers local command and inspection output. They are complementary.

**Does it replace my agent's built-in tools?**
No. It does not intercept native tools. Your host chooses when to call it, and host instructions guide that choice but cannot force it.

## Using it

**How do I recover the full output?**
Run the `recoverStdout=` or `recoverStderr=` command printed in the compact result, or copy a receipt ID and run `npx -y fusion-jev evidence ID --raw` (or `fusion-jev evidence ID --raw` after a global install) or call `fusion_evidence`. Do it within 10 minutes. See [how it works](how-it-works.md#receipt-lifecycle).

**Why did recovery say `expired` or `missing`?**
The receipt passed its 10-minute expiry or was evicted (the store keeps at most 128 receipts and 32 MiB). The CLI and MCP server must also run as the same user to share one store.

**When should I use `--raw`?**
When you want output streamed byte-for-byte as it is produced, whatever its size. `run --raw` prints the output directly and creates no receipt. You do not need it for small output: `run` already prints results of 1 KiB or less verbatim with one status line.

**The tools do not show up in my host.**
Reload the MCP connection or start a fresh session, then run `npx -y fusion-jev doctor stdio`. More in [install troubleshooting](install.md#troubleshooting).

**Is this an official TypeSafe product?**
No. It is an independent community integration; Jev is an external TypeSafe service.
