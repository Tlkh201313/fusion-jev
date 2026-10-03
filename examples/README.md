# Examples

These scripts run from a source checkout (`git clone`, then `npm ci`). They are not part of the published npm package.

| Script | Command | Needs a key? | What it shows |
| --- | --- | --- | --- |
| `workflow.ts` | `npm run demo` | No | A bounded routing workflow with scripted providers: a read-only step followed by a write step that requires explicit authorization. Offline; it does not measure Jev quality. |
| `live.ts` | `FUSION_LIVE_BENCHMARK=1 npm run benchmark:live` | Yes: `TYPESAFE_API_KEY` and `OPENAI_API_KEY` | Runs the same small fixtures as the offline benchmark against live providers (library fallback mode, not the CLI default). Billable. It exits without running unless `FUSION_LIVE_BENCHMARK=1` is set. |

For a keyless first run of the main feature, use the CLI instead:

```sh
npx -y fusion-jev run '--' node -e "for (let i=0;i<200;i++) console.log('line '+i); process.exitCode=2"
```

Offline benchmarks live in [`benchmark/`](../benchmark) (`npm run benchmark`, `npm run benchmark:support -- --corpus=noisy`). To measure savings on a real host, follow [benchmark/real-host.md](../benchmark/real-host.md).
