// SessionStream: tail a native subagent session file (standard OMP session
// JSONL, version 3) and project it into a display transcript — the message
// stream the extension's viewer renders. This is a minimal read-side
// projection of buildSessionContext's transcript mode: we reconstruct
// messages in append order and surface assistant text/thinking/tool calls,
// tool results, and the user task. No OMP core code is touched; the file is
// read-only.

import { readFileSync } from "node:fs";

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

/** Convert a single session entry into a display message (null when not a message). */
function toDisplayMessage(entry: unknown): DisplayMessage | null {
  const e = asRecord(entry);
  if (!e || e.type !== "message") return null;
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

/**
 * Read new session-file bytes since `offset` and append display messages.
 * Session files are append-only; the physical first 256 bytes are a fixed
 * title slot that must be skipped before the logical JSONL body.
 *
 * Invariants:
 * - `offset` is a BYTE offset (matches statSync().size and the nextOffset
 *   contract); all arithmetic is done on the raw Buffer before decoding.
 * - An unterminated trailing line (poll caught a mid-write) is left
 *   unconsumed: nextOffset stays at its start so the next poll re-reads it.
 */
export function readSessionFileTail(filePath: string, offset: number): SessionTranscript {
  const messages: DisplayMessage[] = [];
  let reset = false;

  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    return { messages, nextOffset: offset, reset };
  }

  // A full rewrite (migration or a superseded write) can shrink the file;
  // restart from the body so we don't slice into the middle of new content.
  if (buf.length < offset) {
    offset = 0;
    reset = true;
  }
  if (buf.length <= offset) return { messages, nextOffset: offset, reset };

  // Skip the fixed-width title slot on first read (offset 0): locate the
  // logical session header rather than depending on exact slot padding.
  if (offset === 0) {
    const headerAt = buf.indexOf('{"type":"session"');
    if (headerAt < 0) return { messages, nextOffset: 0, reset };
    offset = headerAt;
  }

  // Decode the new region, then consume only complete lines: drop the final
  // line when it lacks a trailing newline (mid-write), leaving its bytes for
  // the next poll.
  const tail = buf.subarray(offset).toString("utf8");
  let consumed = offset;
  const lines = tail.split("\n");
  // All lines except the last are newline-terminated; the last is complete
  // only when the tail itself ends with a newline.
  const lastComplete = tail.endsWith("\n") ? lines.length : lines.length - 1;
  for (let i = 0; i < lastComplete; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    consumed += Buffer.byteLength(lines[i]) + 1;
    try {
      const entry = JSON.parse(trimmed);
      const msg = toDisplayMessage(entry);
      if (msg) messages.push(msg);
    } catch {
      // complete but malformed line — skip it (do not retry)
    }
  }
  return { messages, nextOffset: consumed, reset };
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
