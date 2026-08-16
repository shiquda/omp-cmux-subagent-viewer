// Integration test: drive the real pipeline (EventBusSource → normalizer →
// registry → writer → cmux layout) with a fake event bus and fake cmux
// runner. Verifies the §22 fixture: two agents, distinct surfaces, events
// routed to correct JSONL, correct final statuses.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { EventBusSource } from "../extension/event-source";
import { EventWriter, makeSessionRoot } from "../extension/event-writer";
import { AgentViewRegistry } from "../extension/agent-view-registry";
import { CmuxClient, type CommandResult } from "../extension/cmux/client";
import { CmuxLayout } from "../extension/cmux/layout";
import type { ExtensionEventBus, ExtensionLogger } from "../extension/omp-api";
import type { AgentView, NormalizedSubagentEvent } from "../extension/types";

const quietLogger: ExtensionLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** In-memory event bus that records subscribers so the test can emit after start. */
class FakeBus implements ExtensionEventBus {
  handlers = new Map<string, Array<(payload: unknown) => void>>();
  on(channel: string, handler: (payload: unknown) => void): unknown {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
    return handler;
  }
  emit(channel: string, payload: unknown): void {
    for (const h of this.handlers.get(channel) ?? []) h(payload);
  }
}

class RecordingRunner {
  calls: string[][] = [];
  surfaceCounter = 0;
  paneCounter = 0;

  async exec(argv: string[]): Promise<CommandResult> {
    this.calls.push(argv);
    const cmd = argv[1];
    if (cmd === "new-pane") {
      this.paneCounter += 1;
      return { code: 0, stdout: `pane:${this.paneCounter}\n`, stderr: "" };
    }
    if (cmd === "new-surface") {
      this.surfaceCounter += 1;
      return { code: 0, stdout: `surface:${this.surfaceCounter}\n`, stderr: "" };
    }
    if (cmd === "list-panes") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "read-screen") {
      return { code: 0, stdout: "➜ repo\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

function lifecycle(agentId: string, agentType: string, status: string) {
  return { id: agentId, agent: agentType, status, agentSource: "bundled" };
}

function progress(agentId: string, currentTool: string, currentToolArgs: string) {
  return {
    index: 0,
    agent: "task",
    progress: { id: agentId, status: "running", currentTool, currentToolArgs, toolCount: 1, durationMs: 5 },
  };
}

function sessionEvent(agentId: string, event: unknown) {
  return { id: agentId, event };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omp-cmux-int-"));
});

describe("pipeline integration (two concurrent subagents)", () => {
  test("A started/completed + B started/failed route to distinct surfaces and JSONL", async () => {
    const bus = new FakeBus();
    const runner = new RecordingRunner();
    const client = new CmuxClient(runner);
    const sessionRoot = makeSessionRoot(root, "session-int");
    const writer = new EventWriter(sessionRoot, quietLogger);
    writer.ensureDirs();
    const registry = new AgentViewRegistry((id) => writer.makeLogPath(id));

    const layout = new CmuxLayout(
      client,
      "workspace:8",
      quietLogger,
      "helper-pane",
      (view: AgentView) => `bun viewer --agent ${view.agentId}`,
      "/repo",
    );

    const received: NormalizedSubagentEvent[] = [];
    const source = new EventBusSource(bus, quietLogger, async (e) => {
      received.push(e);
      writer.append(e.agentId, e);
      if (e.type === "lifecycle") {
        const view = registry.applyLifecycle(e);
        if (view && e.status === "started") {
          const surface = await layout.ensureSurface(view);
          if (surface) registry.attachSurface(e.agentId, surface);
        }
      }
    });
    source.start();

    // Agent A
    bus.emit("task:subagent:lifecycle", lifecycle("A", "scout", "started"));
    bus.emit("task:subagent:progress", progress("A", "read", "src/auth"));
    bus.emit("task:subagent:event", sessionEvent("A", { type: "tool_execution_start", toolName: "read", args: { path: "src/auth" } }));
    bus.emit("task:subagent:event", sessionEvent("A", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "found issue\n" } }));
    bus.emit("task:subagent:lifecycle", lifecycle("A", "scout", "completed"));

    // Agent B
    bus.emit("task:subagent:lifecycle", lifecycle("B", "task", "started"));
    bus.emit("task:subagent:progress", progress("B", "grep", "createSession"));
    bus.emit("task:subagent:event", sessionEvent("B", { type: "tool_execution_start", toolName: "bash", args: { command: "echo hi" } }));
    bus.emit("task:subagent:lifecycle", lifecycle("B", "task", "failed"));

    // Give the async cmux calls time to settle (waitForShell has a fixed 1.5s lead-in).
    await Bun.sleep(2500);

    // 2 views, distinct surfaces, correct statuses
    expect(registry.size()).toBe(2);
    const a = registry.get("A")!;
    const b = registry.get("B")!;
    expect(a.status).toBe("completed");
    expect(b.status).toBe("failed");
    expect(a.cmuxSurfaceId).toBe("surface:1");
    expect(b.cmuxSurfaceId).toBe("surface:2");
    expect(a.cmuxSurfaceId).not.toBe(b.cmuxSurfaceId);

    // One helper pane created, then two surfaces in it.
    const newPanes = runner.calls.filter((c) => c[1] === "new-pane");
    const newSurfaces = runner.calls.filter((c) => c[1] === "new-surface");
    expect(newPanes.length).toBe(1);
    expect(newSurfaces.length).toBe(2);
    // All new-surface calls target the same helper pane.
    for (const call of newSurfaces) {
      expect(call.includes("pane:1")).toBe(true);
    }
    // Focus never stolen.
    for (const call of [...newPanes, ...newSurfaces]) {
      expect(call.includes("--focus") && call[call.indexOf("--focus") + 1]).toBe("false");
    }

    // Events routed to the correct JSONL files.
    const logA = readFileSync(writer.makeLogPath("A"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const logB = readFileSync(writer.makeLogPath("B"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const typesA = logA.map((e) => e.type);
    expect(typesA).toContain("lifecycle");
    expect(typesA).toContain("progress");
    expect(typesA).toContain("session_event");
    expect(logA[0].status).toBe("started");
    expect(logA[logA.length - 1].status).toBe("completed");
    expect(logB[logB.length - 1].status).toBe("failed");
    // No cross-talk: B's log contains no A events.
    for (const e of logB) {
      expect(e.agentId ?? e.id).not.toBe("A");
    }

    // Normalized events were emitted in order.
    expect(received.map((e) => e.agentId)).toContain("A");
    expect(received.map((e) => e.agentId)).toContain("B");

    source.stop();
  });

  test("duplicate lifecycle started does not create a second surface", async () => {
    const bus = new FakeBus();
    const runner = new RecordingRunner();
    const client = new CmuxClient(runner);
    const sessionRoot = makeSessionRoot(root, "session-dup");
    const writer = new EventWriter(sessionRoot, quietLogger);
    writer.ensureDirs();
    const registry = new AgentViewRegistry((id) => writer.makeLogPath(id));
    const layout = new CmuxLayout(client, "workspace:8", quietLogger, "helper-pane", () => "bun viewer", "/repo");

    const source = new EventBusSource(bus, quietLogger, async (e) => {
      writer.append(e.agentId, e);
      if (e.type === "lifecycle") {
        const view = registry.applyLifecycle(e);
        if (view && e.status === "started") {
          const surface = await layout.ensureSurface(view);
          if (surface) registry.attachSurface(e.agentId, surface);
        }
      }
    });
    source.start();

    bus.emit("task:subagent:lifecycle", lifecycle("A", "scout", "started"));
    bus.emit("task:subagent:lifecycle", lifecycle("A", "scout", "started"));
    await Bun.sleep(10);

    expect(registry.size()).toBe(1);
    const surfaces = runner.calls.filter((c) => c[1] === "new-surface");
    expect(surfaces.length).toBe(1);
    source.stop();
  });

  test("unknown channel payloads are ignored without throwing", async () => {
    const bus = new FakeBus();
    const runner = new RecordingRunner();
    const client = new CmuxClient(runner);
    const sessionRoot = makeSessionRoot(root, "session-ign");
    const writer = new EventWriter(sessionRoot, quietLogger);
    writer.ensureDirs();
    const registry = new AgentViewRegistry((id) => writer.makeLogPath(id));
    const layout = new CmuxLayout(client, "workspace:8", quietLogger, "helper-pane", () => "bun viewer", "/repo");
    const source = new EventBusSource(bus, quietLogger, async (e) => {
      writer.append(e.agentId, e);
      if (e.type === "lifecycle") {
        const view = registry.applyLifecycle(e);
        if (view && e.status === "started") {
          const surface = await layout.ensureSurface(view);
          if (surface) registry.attachSurface(e.agentId, surface);
        }
      }
    });
    source.start();

    bus.emit("task:subagent:lifecycle", "garbage");
    bus.emit("task:subagent:progress", { nope: true });
    bus.emit("task:subagent:event", null);
    bus.emit("some:other:channel", { id: "X" });

    expect(registry.size()).toBe(0);
    expect(runner.calls.length).toBe(0);
    source.stop();
  });
});
