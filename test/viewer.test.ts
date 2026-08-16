import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { DisplayMessage } from "../viewer/session-stream";
import { readSessionFileTail } from "../viewer/session-stream";
import { applyEvent, applySessionMessage, createViewerState, formatDuration } from "../viewer/state";
import { ViewerStream } from "../viewer/stream";
import type { NormalizedSubagentEvent } from "../extension/types";

function sessionLine(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

function messageEntry(message: Record<string, unknown>): Record<string, unknown> {
  return { type: "message", id: "x", parentId: null, timestamp: "2026-01-01", message };
}

describe("session-stream (read native subagent session JSONL)", () => {
  test("reconstructs assistant text, tool calls, and tool results", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-sess-"));
    const file = join(dir, "A.jsonl");
    const header = sessionLine({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" });
    writeFileSync(
      file,
      header +
        sessionLine(messageEntry({ role: "user", content: [{ type: "text", text: "Do the thing" }] })) +
        sessionLine(
          messageEntry({
            role: "assistant",
            content: [
              { type: "thinking", thinking: "planning…" },
              { type: "text", text: "Let me read it." },
              { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" }, intent: "Read a.ts" },
            ],
          }),
        ) +
        sessionLine(
          messageEntry({
            role: "toolResult",
            toolName: "read",
            toolCallId: "c1",
            isError: false,
            content: [{ type: "text", text: "file contents" }],
          }),
        ),
    );
    const { messages } = readSessionFileTail(file, 0);
    expect(messages.length).toBe(3);
    const [user, assistant, result] = messages;
    expect(user.role).toBe("user");
    expect(user.text).toBe("Do the thing");
    expect(assistant.role).toBe("assistant");
    expect(assistant.text).toBe("Let me read it.");
    expect(assistant.thinking).toBe("planning…");
    expect(assistant.toolCalls?.[0]).toMatchObject({ name: "read", id: "c1", intent: "Read a.ts" });
    expect(result.role).toBe("toolResult");
    expect(result.toolName).toBe("read");
    expect(result.isError).toBe(false);
    expect(result.text).toBe("file contents");
  });

  test("skips the fixed-width title slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-sess2-"));
    const file = join(dir, "A.jsonl");
    // Simulate the physical 256-byte title slot before the logical header.
    const slot = `${JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "t" })}`.padEnd(256, " ");
    writeFileSync(file, slot + sessionLine({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" }) + sessionLine(messageEntry({ role: "user", content: [{ type: "text", text: "hi" }] })));
    const { messages } = readSessionFileTail(file, 0);
    expect(messages.some((m) => m.role === "user" && m.text === "hi")).toBe(true);
  });

  test("incremental tail from offset reads only new lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-sess3-"));
    const file = join(dir, "A.jsonl");
    writeFileSync(file, sessionLine({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" }) + sessionLine(messageEntry({ role: "user", content: [{ type: "text", text: "one" }] })));
    const first = readSessionFileTail(file, 0);
    expect(first.messages.length).toBe(1);
    appendFileSync(file, sessionLine(messageEntry({ role: "assistant", content: [{ type: "text", text: "two" }] })));
    const second = readSessionFileTail(file, first.nextOffset);
    expect(second.messages.length).toBe(1);
    expect(second.messages[0].text).toBe("two");
    expect(second.reset).toBe(false);
  });

  test("unterminated trailing line is not consumed (re-read next poll)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-sess4-"));
    const file = join(dir, "A.jsonl");
    writeFileSync(file, sessionLine({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" }));
    const base = readSessionFileTail(file, 0);
    // Append a complete line then an unterminated partial line (mid-write).
    const complete = sessionLine(messageEntry({ role: "assistant", content: [{ type: "text", text: "done" }] }));
    const partial = `{"type":"message","id":"y","parentId":null,"timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"incompl`;
    appendFileSync(file, complete + partial);
    const read = readSessionFileTail(file, base.nextOffset);
    expect(read.messages.length).toBe(1);
    expect(read.messages[0].text).toBe("done");
    // nextOffset must not advance past the partial line.
    expect(read.nextOffset).toBe(base.nextOffset + Buffer.byteLength(complete));
    // Complete the partial line; the next read must see it.
    appendFileSync(file, `ete"}]}}\n`);
    const after = readSessionFileTail(file, read.nextOffset);
    expect(after.messages.some((m) => m.text === "incomplete")).toBe(true);
  });

  test("multibyte content uses byte offsets so a shrinking rewrite resets", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-sess5-"));
    const file = join(dir, "A.jsonl");
    // Multibyte content inflates byte size vs char length.
    writeFileSync(file, sessionLine({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" }) + sessionLine(messageEntry({ role: "assistant", content: [{ type: "text", text: "你好你好你好" }] })));
    const first = readSessionFileTail(file, 0);
    expect(first.messages[0].text).toBe("你好你好你好");
    // Shrink the file below the byte offset; must reset and re-read.
    writeFileSync(file, sessionLine({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" }) + sessionLine(messageEntry({ role: "user", content: [{ type: "text", text: "短" }] })));
    const second = readSessionFileTail(file, first.nextOffset);
    expect(second.reset).toBe(true);
    expect(second.messages.some((m) => m.text === "短")).toBe(true);
  });
});

describe("viewer state (turn reconstruction)", () => {
  test("assistant text + tool call + result fold into one turn", () => {
    const state = createViewerState("A", "scout");
    applySessionMessage(state, { role: "assistant", text: "Reading…", toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }] });
    applySessionMessage(state, { role: "toolResult", toolName: "read", text: "contents", isError: false });
    expect(state.turns.length).toBe(1);
    expect(state.turns[0].text).toBe("Reading…");
    expect(state.turns[0].toolCalls[0].done).toBe(true);
    expect(state.turns[0].toolCalls[0].result).toBe("contents");
  });

  test("user task captured once", () => {
    const state = createViewerState("A", "scout");
    applySessionMessage(state, { role: "user", text: "Do it" });
    applySessionMessage(state, { role: "user", text: "ignored second" });
    expect(state.task).toBe("Do it");
  });

  test("yield result sets finalResult", () => {
    const state = createViewerState("A", "task");
    applySessionMessage(state, { role: "toolResult", toolName: "yield", text: '{"summary":"done"}', isError: false });
    expect(state.finalResult).toContain("done");
  });

  test("tool error sets error", () => {
    const state = createViewerState("A", "task");
    applySessionMessage(state, { role: "assistant", toolCalls: [{ id: "c1", name: "bash", args: {} }] });
    applySessionMessage(state, { role: "toolResult", toolName: "bash", text: "boom", isError: true });
    expect(state.error).toBe("boom");
    expect(state.turns[0].toolCalls[0].isError).toBe(true);
  });

  test("current tool set on tool call, cleared on result", () => {
    const state = createViewerState("A", "task");
    applySessionMessage(state, { role: "assistant", toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }] });
    expect(state.currentTool).toBe("read");
    applySessionMessage(state, { role: "toolResult", toolName: "read", text: "x" });
    expect(state.currentTool).toBeUndefined();
  });

  test("duration formatting", () => {
    expect(formatDuration(0, 90_000)).toBe("01:30");
    expect(formatDuration(undefined)).toBe("--:--");
  });

  test("tool_execution_start surfaces a long tool immediately", () => {
    const state = createViewerState("A", "task");
    applySessionMessage(state, {
      role: "toolStart",
      toolStart: { id: "c1", name: "bash", args: { command: "sleep 10" }, intent: "Long op" },
    });
    // The running tool is visible right away, before the assistant message lands.
    expect(state.currentTool).toBe("bash");
    expect(state.currentToolArgs).toContain("sleep 10");
    expect(state.turns[0].toolCalls[0].name).toBe("bash");
    expect(state.turns[0].toolCalls[0].done).toBe(false);
  });

  test("assistant toolCall dedupes against earlier tool_execution_start", () => {
    const state = createViewerState("A", "task");
    applySessionMessage(state, {
      role: "toolStart",
      toolStart: { id: "c1", name: "read", args: { path: "a.ts" } },
    });
    // The assistant message carries the same toolCallId — must not duplicate.
    applySessionMessage(state, {
      role: "assistant",
      text: "done",
      toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }],
    });
    const allCalls = state.turns.flatMap((t) => t.toolCalls);
    expect(allCalls.filter((c) => c.id === "c1").length).toBe(1);
  });

  test("session-stream projects tool_execution_start custom entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-sess-custom-"));
    const file = join(dir, "A.jsonl");
    writeFileSync(
      file,
      sessionLine({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/x" }) +
        sessionLine({
          type: "custom",
          customType: "tool_execution_start",
          id: "c",
          parentId: null,
          timestamp: "t",
          data: { toolCallId: "c1", toolName: "bash", startedAt: "t", args: { command: "x" }, intent: "Run x" },
        }),
    );
    const read = readSessionFileTail(file, 0);
    expect(read.messages.length).toBe(1);
    expect(read.messages[0].role).toBe("toolStart");
    expect(read.messages[0].toolStart?.name).toBe("bash");
    expect(read.messages[0].toolStart?.id).toBe("c1");
  });

  test("progress event surfaces the in-flight tool", () => {
    const state = createViewerState("A", "task");
    applyEvent(state, {
      type: "progress",
      agentId: "A",
      agentType: "task",
      currentTool: "bash",
      currentToolArgs: '{"command":"make"}',
      durationMs: 5000,
      timestamp: 1,
    } as NormalizedSubagentEvent);
    expect(state.currentTool).toBe("bash");
    expect(state.currentToolArgs).toContain("make");
    expect(state.status).toBe("running");
  });
});

describe("viewer stream (extension JSONL)", () => {
  test("seed reads pre-existing lines, start tails appended lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-cmux-stream-"));
    const file = join(dir, "A.jsonl");
    const e1: NormalizedSubagentEvent = { type: "lifecycle", agentId: "A", agentType: "scout", status: "started", timestamp: 1 };
    const e2: NormalizedSubagentEvent = { type: "lifecycle", agentId: "A", agentType: "scout", status: "completed", timestamp: 2 };
    writeFileSync(file, `${JSON.stringify(e1)}\n`);
    const seen: NormalizedSubagentEvent[] = [];
    const stream = new ViewerStream(file, (e) => seen.push(e), 30);
    stream.seed();
    expect(seen).toEqual([e1]);
    stream.start();
    appendFileSync(file, `${JSON.stringify(e2)}\n`);
    await new Promise((r) => setTimeout(r, 120));
    stream.stop();
    expect(seen).toContainEqual(e2);
  });
});
