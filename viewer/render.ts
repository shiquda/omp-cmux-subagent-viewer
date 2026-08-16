// Renderer: ANSI text view of ViewerState, turn-by-turn. Renders the
// reconstructed native transcript (assistant thinking/text, tool calls and
// their results) in message order — the closest faithful projection of the
// native OMP session view without re-running the agent.

import type { Turn, ViewerState } from "./state";
import { STATUS_SYMBOL, formatDuration } from "./state";

const CLEAR = "\x1b[2J\x1b[H";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

const MAX_RENDERED_TURNS = 12;

function statusColor(status: ViewerState["status"]): string {
  switch (status) {
    case "completed":
      return GREEN;
    case "failed":
      return RED;
    case "aborted":
      return YELLOW;
    default:
      return CYAN;
  }
}

function renderToolCall(turn: Turn, callIdx: number): string[] {
  const call = turn.toolCalls[callIdx];
  const lines: string[] = [];
  const marker = call.done ? (call.isError ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`) : `${CYAN}…${RESET}`;
  let header = `  ${marker} ${BOLD}${call.name}${RESET}${call.args ? ` ${DIM}${call.args}${RESET}` : ""}`;
  if (call.diff) {
    const { added, removed } = call.diff;
    const parts: string[] = [];
    if (added > 0) parts.push(`${GREEN}+${added}${RESET}`);
    if (removed > 0) parts.push(`${RED}-${removed}${RESET}`);
    if (parts.length > 0) header += ` ${parts.join(" ")}`;
  }
  lines.push(header);
  if (call.intent) lines.push(`      ${DIM}${call.intent}${RESET}`);
  // Tool output is intentionally omitted: the viewer shows what the agent is
  // doing (tool name + args + intent), not the raw tool results. Assistant
  // text (what the agent says) is rendered separately in renderTurn.
  return lines;
}

function renderTurn(turn: Turn): string[] {
  const lines: string[] = [];
  if (turn.thinking) {
    for (const line of turn.thinking.split("\n").slice(0, 3)) {
      lines.push(`${DIM}  (thinking) ${line}${RESET}`);
    }
  }
  if (turn.text) {
    for (const line of turn.text.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  for (let i = 0; i < turn.toolCalls.length; i += 1) {
    lines.push(...renderToolCall(turn, i));
  }
  return lines;
}

export function renderView(state: ViewerState): string {
  const lines: string[] = [];
  const status = STATUS_SYMBOL[state.status];
  const duration = formatDuration(state.startedAt, state.completedAt);

  lines.push(`${BOLD}${state.agentType}${RESET} ${DIM}· ${state.agentId}${RESET}`);
  lines.push(`${statusColor(state.status)}${status} ${state.status}${RESET} ${DIM}· ${duration}${RESET}`);
  if (state.model || state.thinkingLevel) {
    const modelPart = state.model ? state.model : "";
    const levelPart = state.thinkingLevel ? `thinking:${state.thinkingLevel}` : "";
    const sep = modelPart && levelPart ? " · " : "";
    lines.push(`${MAGENTA}${modelPart}${sep}${levelPart}${RESET}`);
  }
  if (state.description) lines.push(`${DIM}${state.description}${RESET}`);
  lines.push("");

  if (state.task) {
    lines.push(`${BOLD}Task${RESET}`);
    for (const line of state.task.split("\n").slice(0, 4)) lines.push(`${DIM}${line}${RESET}`);
    lines.push("");
  }

  if (state.turns.length > 0) {
    const visible = state.turns.slice(-MAX_RENDERED_TURNS);
    const start = state.turns.length - visible.length;
    if (start > 0) lines.push(`${DIM}… ${start} earlier turn(s) …${RESET}`);
    for (const turn of visible) {
      lines.push(...renderTurn(turn));
    }
    lines.push("");
  }

  if (state.currentTool) {
    lines.push(`${CYAN}▶ ${state.currentTool}${RESET}${state.currentToolArgs ? ` ${DIM}${state.currentToolArgs}${RESET}` : ""}`);
    lines.push("");
  }

  if (state.error) {
    lines.push(`${RED}${BOLD}Error${RESET}`);
    for (const line of state.error.split("\n").slice(0, 6)) lines.push(`  ${line}`);
    lines.push("");
  }
  if (state.finalResult) {
    lines.push(`${GREEN}${BOLD}Result${RESET}`);
    for (const line of state.finalResult.split("\n").slice(0, 12)) lines.push(`  ${line}`);
    lines.push("");
  }

  const terminal = status === "✓" || status === "✗" || status === "■";
  lines.push(`${DIM}${terminal ? "static view — close this tab when done" : "live view — streaming updates"}${RESET}`);
  return lines.join("\n");
}

export function renderClear(state: ViewerState): string {
  return `${CLEAR}${renderView(state)}`;
}
