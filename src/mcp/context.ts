import type { AssistanceService } from '../assist.js';
import type { EvidenceStore } from '../evidence.js';
import type { FusionConfig, RoutingService } from '../types.js';
import type { WorkspaceService } from '../workspace.js';

export type { RoutingService } from '../types.js';

export interface McpOptions {
  router: RoutingService; config: FusionConfig; workspace?: WorkspaceService;
  workspaceFactory?: (root?: string) => WorkspaceService; signal?: AbortSignal; evidence?: EvidenceStore;
}

/** Per-server state and helpers every tool registration shares. */
export interface ToolContext {
  router: RoutingService;
  config: FusionConfig;
  evidence: EvidenceStore;
  getWorkspace(root?: string): WorkspaceService;
  getAssistance(root?: string): AssistanceService;
  /** The call's signal combined with the server and HTTP request signals. */
  mergedSignal(other: AbortSignal): AbortSignal;
  /** `mergedSignal` plus the 15 s per-action deadline used by workspace tools. */
  actionSignal(other: AbortSignal): AbortSignal;
}
