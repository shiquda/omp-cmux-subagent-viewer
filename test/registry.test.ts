import { describe, expect, test } from "bun:test";

import { AgentViewRegistry } from "../extension/agent-view-registry";
import type { LifecycleEvent, ProgressEvent } from "../extension/types";

function lifecycle(partial: Partial<LifecycleEvent> & { agentId: string; status: LifecycleEvent["status"] }): LifecycleEvent {
  return {
    type: "lifecycle",
    agentType: "scout",
    timestamp: 1,
    ...partial,
  } as LifecycleEvent;
}

function progress(agentId: string, durationMs = 10): ProgressEvent {
  return { type: "progress", agentId, durationMs, timestamp: 2 };
}

function makeRegistry(onNewAgent?: (v: unknown) => void) {
  return new AgentViewRegistry((id) => `/tmp/${id}.jsonl`, onNewAgent as never);
}

describe("AgentViewRegistry", () => {
  test("started creates a view, progress flips to running, completed finalizes", () => {
    const registry = makeRegistry();
    const started = registry.applyLifecycle(lifecycle({ agentId: "A", status: "started" }));
    expect(started?.status).toBe("started");
    expect(started?.eventLogPath).toBe("/tmp/A.jsonl");
    expect(registry.get("A")?.agentId).toBe("A");

    registry.applyProgress(progress("A"));
    expect(registry.get("A")?.status).toBe("running");

    const done = registry.applyLifecycle(lifecycle({ agentId: "A", status: "completed", timestamp: 5 }));
    expect(done?.status).toBe("completed");
    expect(done?.completedAt).toBe(5);
  });

  test("duplicate started is idempotent — no duplicate view", () => {
    const created: unknown[] = [];
    const registry = makeRegistry((v) => created.push(v));
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "started" }));
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "started" }));
    expect(created.length).toBe(1);
    expect(registry.size()).toBe(1);
  });

  test("duplicate terminal event does not create a new view", () => {
    const registry = makeRegistry();
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "started" }));
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "completed" }));
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "completed" }));
    expect(registry.size()).toBe(1);
    expect(registry.get("A")?.status).toBe("completed");
  });

  test("progress before started is ignored (fail-open)", () => {
    const registry = makeRegistry();
    registry.applyProgress(progress("Ghost"));
    expect(registry.size()).toBe(0);
  });

  test("terminal after terminal keeps first terminal, refreshes completedAt", () => {
    const registry = makeRegistry();
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "started" }));
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "failed", timestamp: 5 }));
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "completed", timestamp: 9 }));
    expect(registry.get("A")?.status).toBe("failed");
    expect(registry.get("A")?.completedAt).toBe(9);
  });

  test("same-type agents are distinct by id", () => {
    const registry = makeRegistry();
    registry.applyLifecycle(lifecycle({ agentId: "Task", agentType: "task", status: "started" }));
    registry.applyLifecycle(lifecycle({ agentId: "Task-2", agentType: "task", status: "started" }));
    expect(registry.size()).toBe(2);
    expect(registry.get("Task")?.agentType).toBe("task");
    expect(registry.get("Task-2")?.agentType).toBe("task");
  });

  test("attachSurface records the cmux surface ref", () => {
    const registry = makeRegistry();
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "started" }));
    expect(registry.attachSurface("A", "surface:12")).toBe(true);
    expect(registry.get("A")?.cmuxSurfaceId).toBe("surface:12");
    expect(registry.attachSurface("Missing", "surface:1")).toBe(false);
  });

  test("all() returns views in creation order", () => {
    const registry = makeRegistry();
    registry.applyLifecycle(lifecycle({ agentId: "B", status: "started" }));
    registry.applyLifecycle(lifecycle({ agentId: "A", status: "started" }));
    expect(registry.all().map((v) => v.agentId)).toEqual(["B", "A"]);
  });
});
