# Configuration

Only `TYPESAFE_API_KEY` is needed for optional live Jev choices. Deterministic inspection and keyless demos need no credential. The default provider is the official `https://api.typesafe.ai/v1/systemone` endpoint and `jev-latest`. `JEV_API_KEY` is a compatibility alias for the same service. Setting different nonempty values for both keys fails safely. `TEAMOROUTER_API_KEY` does not configure this release. [Official API](https://docs.typesafe.ai/api), [official models and version pinning](https://docs.typesafe.ai/models).

`JEV_MODEL` accepts `jev-latest`, `jev-preview`, or a versioned ID such as `jev-1.13.0`; calibrate your acceptance thresholds when the underlying model changes. `JEV_BASE_URL` accepts only the official canonical origin. Provider redirects are rejected. A present key does not establish that it works.

The public CLI loads a trusted private file through `--provider-env=ABSOLUTE_PATH`, `FUSION_ENV_FILE`, or the per-user saved path, in that order. Process environment values take precedence over file entries. Use `fusion-jev config env-file ABSOLUTE_PATH` to save a path, or `--clear` to remove it. The settings JSON stores only the path. Setup can emit commands without changing files with `fusion-jev setup --dry-run`.

Setup creates a private user-owned directory and files. Existing external provider files must already have private permissions: user-only access on Windows, or mode `600` (or stricter) on Linux/macOS. For a trusted existing Unix file, apply `chmod 600 /absolute/path/to/provider.env` before selecting it. Shared or symbolic-link config files are rejected; setup does not overwrite or silently change an existing file's permissions.

The Windows default settings directory is `~/.fusion-jev-mcp`. Linux/macOS use `${XDG_CONFIG_HOME:-~/.config}/fusion-jev-mcp`. `FUSION_CONFIG_HOME` overrides the base directory and keeps the `fusion-jev-mcp` suffix. The immediate parent must prevent other users from replacing configuration files or the namespace. Unsafe explicit locations fail; Fusion never changes a real profile directory's permissions to make setup pass.

Git inspection reports submodule commit pointers and dirty summaries. It does not recursively include submodule file contents; use an explicitly authorized host inspection when those contents are needed. Repository layouts with redirected directories or unrelated external Git metadata fail closed; ordinary repositories and legitimate linked Git worktrees are supported.

`--provider-env` deliberately differs from Node's `--env-file`: Node 24 can precheck a missing env file even when that option appears after the script path, before the application validates it. Node's own env loading may still be used before the script path, but the public CLI option is `--provider-env`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `FUSION_FALLBACK` | `host` | Keep uncertainty in the current host; the MCP CLI rejects paid API fallback. |
| `FUSION_MCP_PROFILE` | `assist` | Three focused local tools; `full` exposes additional routing and inspection tools. |
| `FUSION_WORKSPACE_ROOT` | process working directory | Exact canonical default project. |
| `FUSION_WORKSPACE_ALLOWED_ROOTS` | empty | Additional exact roots, separated by the platform path delimiter. |
| `JEV_TIMEOUT_MS` | `5000` | Provider request timeout. |
| `FUSION_MIN_CONFIDENCE` | `0.8` | Uncalibrated acceptance threshold. |
| `FUSION_MIN_PROBABILITY` | `0.7` | Minimum selected probability. |
| `FUSION_MIN_MARGIN` | `0.2` | Minimum gap from the second option. |
| `FUSION_MAX_CANDIDATES` | `254` | One further option is reserved for escalation. |
| `FUSION_MAX_BATCH_SIZE` | `16` | Maximum independent routing requests. |
| `FUSION_TOTAL_TIMEOUT_MS` | `20000` | Routing deadline. |
| `FUSION_MAX_CONCURRENCY` | `4` | Provider concurrency limit. |

Local read requests are bounded, literal searches report omissions, and command execution requires the host's authorization. A choice result never grants permission to execute a write. Fusion captures command evidence only when the host deliberately runs the CLI wrapper; it does not intercept commands.

Jev requests may incur TypeSafe charges. Cost estimates are unknown until all three `JEV_INPUT_USD_PER_MILLION`, `JEV_CACHED_INPUT_USD_PER_MILLION`, and `JEV_OUTPUT_USD_PER_MILLION` values are explicitly configured. Use the current provider contract; absent pricing does not mean free inference. Offline token estimates do not establish subscription savings. The host fallback uses the current Codex or Claude session and requires no OpenAI or Anthropic API key.

Advanced library applications may explicitly inject a separately billed generative provider. HTTP/OAuth compatibility remains in the source for existing consumers, but hosted deployment is outside this local release's setup path.
