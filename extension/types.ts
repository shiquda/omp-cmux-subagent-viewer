// Stable protocol types shared between the extension (producer) and the
// viewer (consumer). OMP-specific raw types must never leak past the
// normalizer; this module is the boundary contract.

export type SubagentStatus = "started" | "running" | "completed" | "failed" | "aborted";

export interface LifecycleEvent {
  type: "lifecycle";
  agentId: string;
  agentType: string;
  description?: string;
  status: SubagentStatus;
  parentToolCallId?: string;
  detached?: boolean;
  sessionFile?: string;
  index?: number;
  timestamp: number;
}

export interface ProgressEvent {
  type: "progress";
  agentId: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: unknown[];
  recentTools?: unknown[];
  toolCount?: number;
  tokens?: number;
  durationMs?: number;
  timestamp: number;
}

export interface SessionEventEvent {
  type: "session_event";
  agentId: string;
  event: unknown;
  timestamp: number;
}

export type NormalizedSubagentEvent = LifecycleEvent | ProgressEvent | SessionEventEvent;

export type AgentViewStatus = SubagentStatus;

// Registry-side view of one native subagent.
export interface AgentView {
  agentId: string;
  agentType: string;
  description?: string;
  status: AgentViewStatus;
  /** CMUX surface ref (e.g. "surface:12") once created; undefined until then. */
  cmuxSurfaceId?: string;
  eventLogPath: string;
  startedAt: number;
  completedAt?: number;
  sessionFile?: string;
  parentToolCallId?: string;
  detached?: boolean;
  index?: number;
}

export interface ViewerConfig {
  /** max rendered history lines (viewer) */
  maxEvents: number;
  /** max rendered output lines (viewer) */
  maxOutputLines: number;
  /** max single line length before truncation (viewer) */
  maxLineLength: number;
}

export interface ExtensionConfig {
  enabled: boolean;
  /** "helper-pane" (default) or "split" (fallback per-agent split) */
  layout: "helper-pane" | "split";
  /** keep completed/failed surfaces open (default true) */
  keepSurface: boolean;
  /** root dir for per-session event logs */
  dataDir: string;
  /** show detached/background subagents (default true) */
  showDetached: boolean;
  viewer: ViewerConfig;
}

export const SUBAGENT_CHANNELS = [
  "task:subagent:lifecycle",
  "task:subagent:progress",
  "task:subagent:event",
] as const;
