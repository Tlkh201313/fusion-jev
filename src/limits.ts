const KIB = 1024;
const MIB = 1024 * KIB;

/** Shared size, count and time limits. One frozen object so a limit that two modules must agree on has one definition. */
export const LIMITS = Object.freeze({
  /** Largest evidence page a caller may request, and the page size used by readers that want everything. */
  pageBytes: 64 * KIB,
  /** Default evidence page when the caller names no size. */
  defaultPageBytes: 16 * KIB,
  /** Most bytes captured from one command channel or stored in one receipt. */
  captureBytes: 8 * MIB,
  /** Largest receipt file accepted back from disk (base64 plus JSON framing around a full capture). */
  diskFileBytes: 12 * MIB,
  /** Default Streamable HTTP request body. */
  httpBodyBytes: 128 * KIB,
  /** Default request body for research imports. */
  researchBodyBytes: 2 * MIB,
  /** Default encoded size of one routing request. */
  requestBytes: 128 * KIB,
  /** A single diagnostic line longer than this is dropped rather than parsed. */
  diagnosticLineBytes: 128 * KIB,
  /** Jev choices are single-byte labels, so the candidate count cannot exceed 254. */
  maxCandidates: 254,
  /** Lifetime of a stored receipt and of an orphaned temporary file. */
  receiptTtlMs: 600_000,
  /** First-attempt limit for the Windows ACL verification script (FUSION_ACL_TIMEOUT_MS overrides). */
  aclTimeoutMs: 10_000,
  /** The ACL retry, and a repair already underway, are allowed this many times the first limit. */
  aclRetryFactor: 3,
  /** Each read-only icacls/whoami step of the fast ACL check. */
  aclFastCheckMs: 5000,
  /** How long the ACL script waits for another process's repair of the same directory. */
  aclMutexWaitMs: 10_000,
  /** Stdout/stderr kept from the ACL helper processes, in characters. */
  helperOutputChars: 4096,
  /** The one-shot privacy check of a configuration path. */
  privacyCheckMs: 10_000,
  /** The Windows process-tree snapshot and terminate helpers. */
  treeHelperMs: 3500,
  /** After a timeout or cancel, how long to wait for cleanup before settling without the child's streams. */
  treeCleanupMs: 4500,
  /** Output cap of a Windows process-tree helper. */
  treeHelperOutputBytes: 64 * KIB,
  /** How long SQLite waits on another process's lock. */
  sqliteBusyMs: 5000,
} as const);
