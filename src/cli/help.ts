export const HELP = `Fusion Jev: local coding evidence and optional guarded choices

Usage: fusion-jev [setup | stdio | http | doctor [stdio|http] | config doctor | --help] [--provider-env=ABSOLUTE_PATH]
       fusion-jev config env-file <ABSOLUTE_PATH | --clear>
        fusion-jev run [--raw] [--timeout-ms=N] [--max-capture-bytes=N] [--cwd=ABSOLUTE_PATH] -- program argv...
        fusion-jev evidence ID [--start-byte=N] [--max-bytes=N] [--raw]

setup          Create private provider template and emit host connection commands.
stdio          Run local MCP over stdin/stdout (default).
http           Run Streamable HTTP at /mcp and health at /healthz.
doctor         Check configuration locally; does not call providers.
config doctor  Alias for doctor.

Environment: TYPESAFE_API_KEY for Jev; FUSION_FALLBACK=host.
Use --provider-env=ABSOLUTE_PATH, FUSION_ENV_FILE, or a saved per-user path to load a trusted env file.
Local stdio exposes named read-only file/search/Git tools, plus Jev routing.
Pass an approved root for the active local project, or set FUSION_WORKSPACE_ROOT as a default.
Additional local roots must be listed in FUSION_WORKSPACE_ALLOWED_ROOTS, separated
by the platform path delimiter; roots outside that allowlist are rejected.
HTTP exposes workspace tools only when FUSION_HTTP_ENABLE_WORKSPACE=true and
FUSION_WORKSPACE_ROOT points to a server-side project. Otherwise it is a
general Jev decision service and does not expose repository files.
Uncertain work returns to the current Codex or Claude host session.
Remote HTTP requires FUSION_PUBLIC_URL and complete external OAuth settings.
Source-checkout npm scripts load .env; the global fusion-jev command does not load it implicitly.
Provider keys are never returned to clients. See README.md and .env.example.
`;
