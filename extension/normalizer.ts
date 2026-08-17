// OMP raw payload → NormalizedSubagentEvent.
//
// OMP-specific parsing is confined to this module (and event-source/). The
// registry, cmux layer, and viewer consume only the normalized protocol in
// types.ts. Parsing is defensive (fail-open): malformed or unknown payloads
// return null and are ignored upstream, never thrown.

import type {
  LifecycleEvent,
  NormalizedSubagentEvent,
  ProgressEvent,
  SessionEventEvent,
  SubagentStatus,
} from "./types";

export type Channel = "task:subagent:lifecycle" | "task:subagent:progress" | "task:subagent:event";

export function isSubagentChannel(name: string): name is Channel {
  return (
    name === "task:subagent:lifecycle" ||
    name === "task:subagent:progress" ||
    name === "task:subagent:event"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATUSES: readonly SubagentStatus[] = ["started", "running", "completed", "failed", "aborted"];

// Map an OMP lifecycle status to our normalized status. The wire emits
// started/completed/failed/aborted; "running" is synthesized by the registry
// when the first progress arrives after started.
export function normalizeLifecycle(payload: unknown): LifecycleEvent | null {
  if (!isRecord(payload)) return null;
  const agentId = typeof payload.id === "string" ? payload.id : undefined;
  const agentType = typeof payload.agent === "string" ? payload.agent : undefined;
  const status =
    typeof payload.status === "string" &&
    (STATUSES as readonly string[]).includes(payload.status)
      ? (payload.status as SubagentStatus)
      : undefined;
  if (!agentId || !agentType || !status) return null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    type: "lifecycle",
    agentId,
    agentType,
    description: str(payload.description),
    status,
    parentToolCallId: str(payload.parentToolCallId),
    detached: typeof payload.detached === "boolean" ? payload.detached : undefined,
    sessionFile: str(payload.sessionFile),
    index: typeof payload.index === "number" && Number.isFinite(payload.index) ? payload.index : undefined,
    timestamp: Date.now(),
  };
}

// The progress payload is an envelope: outer { index, agent, agentSource,
// assignment, parentToolCallId, detached, sessionFile, task, progress } where
// progress is the AgentProgress object { id, status, currentTool,
// currentToolArgs, recentTools, recentOutput, toolCount, tokens, durationMs,
// ... }. Verified against omp 17.3.4.
export function normalizeProgress(payload: unknown): ProgressEvent | null {
  if (!isRecord(payload)) return null;
  const inner = payload.progress;
  if (!isRecord(inner)) return null;

  const agentId = typeof inner.id === "string" ? inner.id : typeof payload.id === "string" ? payload.id : undefined;
  if (!agentId) return null;

  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    type: "progress",
    agentId,
    currentTool: str(inner.currentTool),
    currentToolArgs: str(inner.currentToolArgs),
    recentTools: Array.isArray(inner.recentTools) ? (inner.recentTools as unknown[]) : undefined,
    recentOutput: Array.isArray(inner.recentOutput) ? (inner.recentOutput as unknown[]) : undefined,
    toolCount: num(inner.toolCount),
    tokens: num(inner.tokens),
    durationMs: num(inner.durationMs),
    timestamp: Date.now(),
  };
}

/**
 * Keep only the two session signals the viewer consumes between native-session
 * polls. Message deltas contain the complete partial message and can be tens
 * of kilobytes each; the native session file is the authoritative transcript.
 */
function compactSessionEvent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "tool_execution_start" && value.type !== "tool_execution_end") return undefined;

  const compact: Record<string, unknown> = { type: value.type };
  for (const key of ["toolCallId", "toolName"] as const) {
    if (typeof value[key] === "string" && value[key].length > 0) compact[key] = value[key];
  }
  return compact;
}

export function normalizeSessionEvent(payload: unknown): SessionEventEvent | null {
  if (!isRecord(payload)) return null;
  const agentId = typeof payload.id === "string" ? payload.id : undefined;
  const event = compactSessionEvent(payload.event);
  if (!agentId || !event) return null;
  return { type: "session_event", agentId, event, timestamp: Date.now() };
}

export function normalizeChannelEvent(channel: Channel, payload: unknown): NormalizedSubagentEvent | null {
  switch (channel) {
    case "task:subagent:lifecycle":
      return normalizeLifecycle(payload);
    case "task:subagent:progress":
      return normalizeProgress(payload);
    case "task:subagent:event":
      return normalizeSessionEvent(payload);
    default:
      return null;
  }
}
