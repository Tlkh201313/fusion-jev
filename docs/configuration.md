# Configuration

Only `TYPESAFE_API_KEY` is needed, and only for optional live Jev choices. Command capture, inspection and evidence recovery need no credential. For first-time setup see [install](install.md).

## Provider

- The provider is the official TypeSafe API (`https://api.typesafe.ai`) with model `jev-latest`. See the [API reference](https://docs.typesafe.ai/api) and [models and version pinning](https://docs.typesafe.ai/models).
- `JEV_API_KEY` is accepted as an alias for `TYPESAFE_API_KEY`. Setting both to different nonempty values fails safely.
- `JEV_MODEL` accepts `jev-latest`, `jev-preview`, or a versioned ID such as `jev-1.13.0`. Recalibrate your acceptance thresholds when the underlying model changes.
- `JEV_BASE_URL` accepts only the official origin, and provider redirects are rejected.
- A present key does not prove it works. `fusion-jev doctor` checks presence only and makes no network request.

## Private provider file

The CLI loads a trusted private env file from, in order: `--provider-env=ABSOLUTE_PATH`, `FUSION_ENV_FILE`, then the saved per-user path. Process environment values take precedence over file entries. Fusion never searches the working directory for a `.env`; source-checkout npm scripts may load the checkout's `.env`, so keep it git-ignored.

```sh
fusion-jev setup --dry-run                                  # preview, writes nothing
fusion-jev config env-file /absolute/path/to/provider.env   # save a path
fusion-jev config env-file --clear                          # remove the saved path
```

The saved settings JSON stores only the path. `--provider-env` is the CLI's own option; it is not Node's `--env-file`.

Setup creates a private user-owned directory and files and never overwrites or loosens an existing file. Existing external provider files must already be private: user-only access on Windows, or mode `600` or stricter on Linux/macOS (`chmod 600 /absolute/path/to/provider.env`). Shared or symbolic-link config files are rejected.

## Locations

| Platform | Settings directory |
| --- | --- |
| Windows | `~/.fusion-jev-mcp` |
| Linux / macOS | `${XDG_CONFIG_HOME:-~/.config}/fusion-jev-mcp` |

`FUSION_CONFIG_HOME` overrides the base directory and keeps the `fusion-jev-mcp` suffix. Its immediate parent must prevent other users from replacing configuration files. Unsafe explicit locations fail; Fusion never changes a real profile directory's permissions. Receipts live in the user cache directory under `fusion-jev-mcp/evidence`.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `FUSION_FALLBACK` | `host` | Keep uncertainty in the current host. The CLI rejects any other value. |
| `FUSION_MCP_PROFILE` | `assist` | `assist` exposes three focused tools; `full` adds routing and inspection tools. |
| `FUSION_WORKSPACE_ROOT` | process working directory | Exact canonical default project. |
| `FUSION_WORKSPACE_ALLOWED_ROOTS` | empty | Additional exact roots, separated by the platform path delimiter (`;` on Windows, `:` elsewhere). |
| `JEV_TIMEOUT_MS` | `5000` | Provider request timeout. |
| `FUSION_MIN_CONFIDENCE` | `0.8` | Uncalibrated acceptance threshold. |
| `FUSION_MIN_PROBABILITY` | `0.7` | Minimum selected probability. |
| `FUSION_MIN_MARGIN` | `0.2` | Minimum gap from the second option. |
| `FUSION_MAX_CANDIDATES` | `254` | Maximum candidates; one further option is reserved for escalation. |
| `FUSION_MAX_BATCH_SIZE` | `16` | Maximum independent routing requests. |
| `FUSION_TOTAL_TIMEOUT_MS` | `20000` | Routing deadline. |
| `FUSION_MAX_CONCURRENCY` | `4` | Provider concurrency limit. |

## Behavior notes

- Local read requests are bounded, literal searches report omissions, and command execution requires the host's authorization. A choice result never grants permission to execute a write.
- Fusion captures command output only when the host deliberately runs the `fusion-jev run` wrapper; it does not intercept commands.
- Git inspection reports submodule commit pointers and dirty summaries but does not include submodule file contents. Repository layouts with redirected directories or unrelated external Git metadata fail closed; ordinary repositories and linked worktrees are supported.

## Cost

Jev requests may incur TypeSafe charges. Cost estimates are unknown until all three of `JEV_INPUT_USD_PER_MILLION`, `JEV_CACHED_INPUT_USD_PER_MILLION` and `JEV_OUTPUT_USD_PER_MILLION` are set to the provider's current rates; an absent price does not mean free. Fallback uses your current Claude Code or Codex session and needs no Anthropic or OpenAI API key.

## HTTP mode (advanced)

`fusion-jev http` serves Streamable HTTP at `/mcp` with a health check at `/healthz`. It is kept for existing integrations and is not part of the supported setup path. Remote use requires `FUSION_PUBLIC_URL` and complete OAuth settings; see `.env.example` and `fusion-jev --help`. Applications using the TypeScript library may inject their own generative provider.
