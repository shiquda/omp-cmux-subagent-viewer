// ViewerState: fold session-derived display messages into a bounded,
// turn-structured display state. Data source is the subagent's session file
// (native OMP message stream); rendering stays decoupled from that wire.
//
// Design: the viewer is a read-side projection. It reconstructs each turn's
// assistant content (thinking, text, tool calls) and the matching tool
// results, then renders them in message order — the closest faithful view of
// the native OMP transcript without re-running the agent.

import type { DisplayMessage } from "./session-stream";
import type { LifecycleEvent, NormalizedSubagentEvent, ProgressEvent, SubagentStatus } from "../extension/types";

export interface ToolCallEntry {
  id: string;
  name: string;
  args: string;
  intent?: string;
  /** edit/write change size: lines added / removed (green/red in the view). */
  diff?: { added: number; removed: number };
  /** true once the matching toolResult arrived */
  done: boolean;
  isError?: boolean;
  result?: string;
}

/** One logical turn: an assistant message (thinking + text + tool calls) plus its results. */
export interface Turn {
  index: number;
  thinking?: string;
  text?: string;
  toolCalls: ToolCallEntry[];
}

export interface ViewerState {
  agentId: string;
  agentType: string;
  description?: string;
  status: SubagentStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  /** user task (first user message) */
  task?: string;
  /** reconstructed turns in order */
  turns: Turn[];
  /** recent tools for the header summary (bounded) */
  recentTools: ToolCallEntry[];
  /** current in-flight tool (latest unfinished tool call) */
  currentTool?: string;
  currentToolArgs?: string;
  error?: string;
  finalResult?: string;
}

const MAX_LINE_LENGTH = 400;
const MAX_TURNS = 50;
const MAX_RECENT = 30;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createViewerState(agentId: string, agentType: string): ViewerState {
  return {
    agentId,
    agentType,
    status: "started",
    turns: [],
    recentTools: [],
  };
}

// ---------------------------------------------------------------------------
// Lifecycle / progress (from the extension bus) — header state only.
// ---------------------------------------------------------------------------

function applyLifecycle(state: ViewerState, event: LifecycleEvent): void {
  state.status = event.status;
  if (event.agentType) state.agentType = event.agentType;
  if (event.description !== undefined) state.description = event.description;
  if (event.status === "started") state.startedAt = event.timestamp;
  if (event.status === "completed" || event.status === "failed" || event.status === "aborted") {
    state.completedAt = event.timestamp;
  }
}

function applyProgress(state: ViewerState, event: ProgressEvent): void {
  if (state.status === "started") state.status = "running";
  if (event.durationMs !== undefined && event.durationMs > 0) state.durationMs = event.durationMs;
  // Surface the in-flight tool from the progress stream so a long-running
  // tool shows up immediately, before its assistant/toolResult messages land
  // in the session file (which is only tailed on a poll cadence).
  if (event.currentTool !== undefined) state.currentTool = event.currentTool;
  if (event.currentToolArgs !== undefined) {
    state.currentToolArgs = truncate(event.currentToolArgs, MAX_LINE_LENGTH);
  }
}

// ---------------------------------------------------------------------------
// Session messages (the native transcript) — turn reconstruction.
// ---------------------------------------------------------------------------

function currentTurn(state: ViewerState): Turn {
  let turn = state.turns[state.turns.length - 1];
  if (!turn) {
    turn = { index: state.turns.length, toolCalls: [] };
    state.turns.push(turn);
    if (state.turns.length > MAX_TURNS) state.turns.splice(0, state.turns.length - MAX_TURNS);
  }
  return turn;
}

function pushTool(state: ViewerState, entry: ToolCallEntry): void {
  state.recentTools.push(entry);
  if (state.recentTools.length > MAX_RECENT) {
    state.recentTools.splice(0, state.recentTools.length - MAX_RECENT);
  }
}

/**
 * Compact, human-facing summary of a tool call's args. We surface the one
 * field that identifies what the tool acts on instead of the full JSON blob:
 * bash → command, file tools → path, search tools → pattern, etc. Falls back
 * to truncated JSON for anything unrecognized.
 */
function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

/**
 * Line-change size for edit/write-style tools, derived from the raw args.
 * edit → old_string vs new_string line counts; write → content line count as
 * pure additions. Returns undefined for tools without a meaningful diff.
 */
function diffStats(name: string, args: unknown): { added: number; removed: number } | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  if (name === "edit" || name === "multiedit") {
    const added = countLines(a.new_string);
    const removed = countLines(a.old_string);
    if (added === 0 && removed === 0) return undefined;
    return { added, removed };
  }
  if (name === "write") {
    const added = countLines(a.content);
    if (added === 0) return undefined;
    return { added, removed: 0 };
  }
  return undefined;
}

function argsSummary(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return truncate(args, MAX_LINE_LENGTH);
  if (typeof args !== "object" || Array.isArray(args)) {
    try {
      return truncate(JSON.stringify(args), MAX_LINE_LENGTH);
    } catch {
      return "";
    }
  }
  const a = args as Record<string, unknown>;
  // The single most identifying field per common tool, in priority order.
  const KEYS = ["command", "path", "pattern", "file_path", "query", "url", "task", "prompt"];
  for (const key of KEYS) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) return truncate(v, MAX_LINE_LENGTH);
  }
  try {
    return truncate(JSON.stringify(args), MAX_LINE_LENGTH);
  } catch {
    return "";
  }
}

/** Match an incoming toolResult to its tool call across turns and recent list. */
function resolveToolCall(state: ViewerState, message: DisplayMessage): void {
  const name = message.toolName;
  const resultText = message.text ?? "";
  // Find the most recent unfinished tool call with a matching name.
  for (let i = state.turns.length - 1; i >= 0; i -= 1) {
    const t = state.turns[i].toolCalls.find((c) => !c.done && (name === undefined || c.name === name));
    if (t) {
      t.done = true;
      t.isError = message.isError;
      t.result = truncate(resultText, MAX_LINE_LENGTH * 4);
      return;
    }
  }
  // No match — still record the result as a standalone recent entry.
  pushTool(state, {
    id: "",
    name: name ?? "tool",
    args: "",
    done: true,
    isError: message.isError,
    result: truncate(resultText, MAX_LINE_LENGTH * 4),
  });
}

export function applySessionMessage(state: ViewerState, message: DisplayMessage): void {
  if (message.role === "user") {
    if (state.task === undefined && message.text) state.task = truncate(message.text, MAX_LINE_LENGTH * 4);
    return;
  }

  // tool_execution_start (custom entry): a tool is running now, ahead of the
  // assistant message that will carry the same toolCall once the turn lands.
  // Dedupe by toolCallId — if the call is already in a turn, don't add it
  // twice; otherwise add a pending entry so long tools are visible.
  if (message.role === "toolStart" && message.toolStart) {
    const call = message.toolStart;
    const already = state.turns.some((t) => t.toolCalls.some((c) => c.id === call.id && call.id !== ""));
    if (!already) {
      const turn = currentTurn(state);
      const entry: ToolCallEntry = {
        id: call.id,
        name: call.name,
        args: argsSummary(call.args),
        intent: call.intent,
        diff: diffStats(call.name, call.args),
        done: false,
      };
      turn.toolCalls.push(entry);
      pushTool(state, entry);
    }
    state.currentTool = call.name;
    state.currentToolArgs = argsSummary(call.args);
    return;
  }

  if (message.role === "assistant") {
    // A new assistant message starts a new turn only when the previous turn
    // already has content; otherwise reuse it (keeps turn boundaries clean).
    const prev = state.turns[state.turns.length - 1];
    if (prev && (prev.text !== undefined || prev.toolCalls.length > 0 || prev.thinking !== undefined)) {
      state.turns.push({ index: state.turns.length, toolCalls: [] });
      if (state.turns.length > MAX_TURNS) state.turns.splice(0, state.turns.length - MAX_TURNS);
    }
    const turn = currentTurn(state);
    if (message.thinking) turn.thinking = truncate(message.thinking, MAX_LINE_LENGTH * 4);
    if (message.text) turn.text = truncate(message.text, MAX_LINE_LENGTH * 4);
    for (const call of message.toolCalls ?? []) {
      // Skip if this toolCall was already added as a pending entry from an
      // earlier tool_execution_start (same toolCallId).
      if (call.id && state.turns.some((t) => t.toolCalls.some((c) => c.id === call.id))) {
        continue;
      }
      const entry: ToolCallEntry = {
        id: call.id,
        name: call.name,
        args: argsSummary(call.args),
        intent: call.intent,
        diff: diffStats(call.name, call.args),
        done: false,
      };
      turn.toolCalls.push(entry);
      pushTool(state, entry);
      state.currentTool = call.name;
      state.currentToolArgs = entry.args;
    }
    return;
  }

  if (message.role === "toolResult") {
    resolveToolCall(state, message);
    if (message.isError && message.text) state.error = truncate(message.text, MAX_LINE_LENGTH * 4);
    // The hidden `yield` tool carries the subagent's final structured result.
    if (message.toolName === "yield" && message.text) {
      state.finalResult = truncate(message.text, MAX_LINE_LENGTH * 6);
    }
    // A finished tool call clears the current tool.
    state.currentTool = undefined;
    state.currentToolArgs = undefined;
    return;
  }
}

// ---------------------------------------------------------------------------
// Dispatch: lifecycle/progress events from the extension bus, or a session
// message reconstructed from the session file.
// ---------------------------------------------------------------------------

export function applyEvent(state: ViewerState, event: NormalizedSubagentEvent): void {
  switch (event.type) {
    case "lifecycle":
      applyLifecycle(state, event);
      break;
    case "progress":
      applyProgress(state, event);
      break;
    case "session_event":
      applySessionEvent(state, event.event);
      break;
  }
}

function applySessionEvent(state: ViewerState, event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const e = event as Record<string, unknown>;
  if (e.type === "session_message") {
    const m = e.message as DisplayMessage | undefined;
    if (m) applySessionMessage(state, m);
    return;
  }
  // Backwards-compatible raw session events from the bus: keep tool display
  // responsive between session-file polls by mirroring tool_execution_*.
  if (e.type === "tool_execution_start") {
    state.currentTool = typeof e.toolName === "string" ? e.toolName : undefined;
    state.currentToolArgs = undefined;
  } else if (e.type === "tool_execution_end") {
    state.currentTool = undefined;
    state.currentToolArgs = undefined;
  }
}

export function formatDuration(startedAt?: number, completedAt?: number): string {
  if (startedAt === undefined) return "--:--";
  const end = completedAt ?? Date.now();
  const totalMs = Math.max(0, end - startedAt);
  const m = Math.floor(totalMs / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const STATUS_SYMBOL: Record<SubagentStatus, string> = {
  started: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  aborted: "■",
};
