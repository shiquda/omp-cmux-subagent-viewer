// SessionStream: tail a native subagent session file (standard OMP session
// JSONL, version 3) and project it into a display transcript — the message
// stream the extension's viewer renders. This is a minimal read-side
// projection of buildSessionContext's transcript mode: we reconstruct
// messages in append order and surface assistant text/thinking/tool calls,
// tool results, and the user task. No OMP core code is touched; the file is
// read-only.

import { closeSync, openSync, readSync, statSync } from "node:fs";

import type { NormalizedSubagentEvent } from "../extension/types";

export interface DisplayToolCall {
  id: string;
  name: string;
  args: unknown;
  intent?: string;
}

export interface DisplayMessage {
  role: "user" | "assistant" | "toolResult" | string;
  text?: string;
  thinking?: string;
  toolCalls?: DisplayToolCall[];
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  /**
   * For a single tool execution projected from a `custom` entry
   * (tool_execution_start): the running tool call, keyed by toolCallId so the
   * viewer can dedupe it against the assistant message that carries the same
   * call once it lands.
   */
  toolStart?: DisplayToolCall;
  /**
   * Session metadata projected from model_change / thinking_level_change
   * entries: the subagent's model and reasoning (thinking) level, shown in
   * the viewer header.
   */
  meta?: { model?: string; thinkingLevel?: string };
}

export interface SessionTranscript {
  messages: DisplayMessage[];
  /** byte offset consumed so far — resume tailing from here. */
  nextOffset: number;
  /** true when the file was replaced/truncated and reading restarted. */
  reset: boolean;
}

const TITLE_SLOT_BYTES = 256;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Convert a single session entry into a display message (null when not displayable). */
function toDisplayMessage(entry: unknown): DisplayMessage | null {
  const e = asRecord(entry);
  if (!e) return null;

  // `custom` entries carry real-time tool signals that precede the assistant
  // message (which is written once, after the whole turn's blocks are known).
  // Project tool_execution_start so a long-running tool shows up immediately.
  if (e.type === "custom") {
    if (e.customType !== "tool_execution_start") return null;
    const data = asRecord(e.data);
    if (!data) return null;
    const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
    if (!toolName) return null;
    return {
      role: "toolStart",
      toolStart: {
        id: typeof data.toolCallId === "string" ? data.toolCallId : "",
        name: toolName,
        args: data.args,
        intent: typeof data.intent === "string" ? data.intent : undefined,
      },
    };
  }

  // Session metadata: the subagent's model and reasoning level, projected so
  // the viewer header can show them.
  if (e.type === "model_change") {
    const model = typeof e.model === "string" ? e.model : undefined;
    return model ? { role: "meta", meta: { model } } : null;
  }
  if (e.type === "thinking_level_change") {
    const thinkingLevel = typeof e.thinkingLevel === "string" ? e.thinkingLevel : undefined;
    return thinkingLevel ? { role: "meta", meta: { thinkingLevel } } : null;
  }

  if (e.type !== "message") return null;
  const m = asRecord(e.message);
  if (!m) return null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : undefined;

  if (role === "assistant") {
    const content = m.content;
    const toolCalls: DisplayToolCall[] = [];
    let thinking: string | undefined;
    let text: string | undefined;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        const b = asRecord(block);
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) texts.push(b.text);
        else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          thinking = (thinking ? thinking + "\n" : "") + b.thinking;
        } else if (b.type === "toolCall") {
          toolCalls.push({
            id: typeof b.id === "string" ? b.id : "",
            name: typeof b.name === "string" ? b.name : "tool",
            args: b.arguments,
            intent: typeof b.intent === "string" ? b.intent : undefined,
          });
        }
      }
      text = texts.length > 0 ? texts.join("\n") : undefined;
    }
    return { role, text, thinking, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, timestamp };
  }

  if (role === "toolResult") {
    const content = m.content;
    const text = textFromContent(content);
    return {
      role,
      text,
      toolName: typeof m.toolName === "string" ? m.toolName : undefined,
      isError: m.isError === true,
      timestamp,
    };
  }

  if (role === "user") {
    return { role, text: textFromContent(m.content), timestamp };
  }

  return { role, timestamp };
}

const READ_CHUNK_BYTES = 64 * 1024;
const SESSION_HEADER = Buffer.from('{"type":"session"');

/**
 * Read new session-file bytes since `offset` without loading the transcript
 * into one large string. The returned offset points at the start of an
 * unterminated line so a mid-write line is retried on the next poll.
 */
export function readSessionFileTail(filePath: string, offset: number): SessionTranscript {
  const messages: DisplayMessage[] = [];
  let reset = false;
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { messages, nextOffset: offset, reset };
  }

  if (size < offset) {
    offset = 0;
    reset = true;
  }
  if (size <= offset) return { messages, nextOffset: offset, reset };

  // The physical title slot precedes the logical JSONL body. Probe only the
  // first chunk to locate the session header, then tail from that byte.
  if (offset === 0) {
    const probeSize = Math.min(READ_CHUNK_BYTES, size);
    let probeFd: number | undefined;
    try {
      probeFd = openSync(filePath, "r");
      const probe = Buffer.allocUnsafe(probeSize);
      const bytesRead = readSync(probeFd, probe, 0, probeSize, 0);
      closeSync(probeFd);
      probeFd = undefined;
      const headerAt = probe.subarray(0, bytesRead).indexOf(SESSION_HEADER);
      if (headerAt < 0) return { messages, nextOffset: 0, reset };
      offset = headerAt;
    } catch {
      if (probeFd !== undefined) closeSync(probeFd);
      return { messages, nextOffset: 0, reset };
    }
  }

  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return { messages, nextOffset: offset, reset };
  }

  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let position = offset;
  let pending = Buffer.alloc(0);
  try {
    while (position < size) {
      const requested = Math.min(chunk.length, size - position);
      const bytesRead = readSync(fd, chunk, 0, requested, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = pending.length > 0 ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      while (true) {
        const newline = data.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        const line = data.subarray(lineStart, newline).toString("utf8").trim();
        if (line) {
          try {
            const entry = JSON.parse(line);
            const message = toDisplayMessage(entry);
            if (message) messages.push(message);
          } catch {
            // Complete but malformed line — skip it (do not retry).
          }
        }
        lineStart = newline + 1;
      }
      pending = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : Buffer.alloc(0);
    }
  } finally {
    closeSync(fd);
  }

  return { messages, nextOffset: position - pending.length, reset };
}

/** Reconstruct the full transcript from the start (no incremental offset). */
export function readSessionTranscript(filePath: string): DisplayMessage[] {
  return readSessionFileTail(filePath, 0).messages;
}

// ---------------------------------------------------------------------------
// Adapter: expose the session tail as the viewer's NormalizedSubagentEvent
// stream so viewer/state.ts rendering can consume both raw session events and
// reconstructed messages through one interface. The viewer uses this to merge
// session-derived turns with the existing lifecycle/progress stream.
// ---------------------------------------------------------------------------

export function sessionMessageToEvent(agentId: string, message: DisplayMessage): NormalizedSubagentEvent {
  return {
    type: "session_event",
    agentId,
    event: { type: "session_message", message },
    timestamp: Date.now(),
  };
}
