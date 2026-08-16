import { describe, expect, test } from "bun:test";

import {
  normalizeLifecycle,
  normalizeProgress,
  normalizeSessionEvent,
} from "../extension/normalizer";
import type { LifecycleEvent, ProgressEvent } from "../extension/types";

describe("normalizeLifecycle", () => {
  test("started payload maps to normalized lifecycle event", () => {
    const payload = {
      id: "ScoutA",
      agent: "scout",
      agentSource: "bundled",
      description: "ScoutA",
      status: "started",
      sessionFile: "/tmp/sessions/ScoutA.jsonl",
      parentToolCallId: "call_1",
      index: 0,
      detached: true,
    };
    const event = normalizeLifecycle(payload) as LifecycleEvent | null;
    expect(event).not.toBeNull();
    expect(event!.type).toBe("lifecycle");
    expect(event!.agentId).toBe("ScoutA");
    expect(event!.agentType).toBe("scout");
    expect(event!.status).toBe("started");
    expect(event!.parentToolCallId).toBe("call_1");
    expect(event!.detached).toBe(true);
    expect(event!.index).toBe(0);
    expect(event!.timestamp).toBeGreaterThan(0);
  });

  test("completed maps through", () => {
    const event = normalizeLifecycle({ id: "A", agent: "task", status: "completed" }) as LifecycleEvent | null;
    expect(event?.status).toBe("completed");
  });

  test("malformed payload returns null (fail-open)", () => {
    expect(normalizeLifecycle(null)).toBeNull();
    expect(normalizeLifecycle("nope")).toBeNull();
    expect(normalizeLifecycle({})).toBeNull();
    expect(normalizeLifecycle({ id: "A" })).toBeNull();
    expect(normalizeLifecycle({ id: "A", agent: "task", status: "bogus" })).toBeNull();
    expect(normalizeLifecycle({ id: "A", agent: "task", status: "started", extra: 1 })).not.toBeNull();
  });

  test("unknown fields are dropped, known optional fields preserved", () => {
    const event = normalizeLifecycle({
      id: "A",
      agent: "reviewer",
      status: "failed",
      sessionFile: "/x/y.jsonl",
      detached: false,
    }) as LifecycleEvent | null;
    expect(event?.sessionFile).toBe("/x/y.jsonl");
    expect(event?.detached).toBe(false);
    expect("extra" in (event ?? {})).toBe(false);
  });
});

describe("normalizeProgress", () => {
  test("envelope shape: inner progress object is the source", () => {
    const payload = {
      index: 0,
      agent: "scout",
      progress: {
        id: "ScoutA",
        status: "running",
        currentTool: "grep",
        currentToolArgs: "createSession",
        recentTools: [{ tool: "read", args: "src/auth/session.ts", endMs: 1 }],
        recentOutput: ["line one", "line two"],
        toolCount: 3,
        tokens: 100,
        durationMs: 1500,
      },
    };
    const event = normalizeProgress(payload) as ProgressEvent | null;
    expect(event).not.toBeNull();
    expect(event!.agentId).toBe("ScoutA");
    expect(event!.currentTool).toBe("grep");
    expect(event!.currentToolArgs).toBe("createSession");
    expect(event!.recentTools).toEqual([{ tool: "read", args: "src/auth/session.ts", endMs: 1 }]);
    expect(event!.toolCount).toBe(3);
    expect(event!.durationMs).toBe(1500);
  });

  test("missing progress object returns null", () => {
    expect(normalizeProgress({ id: "A" })).toBeNull();
    expect(normalizeProgress({ progress: "x" })).toBeNull();
  });
});

describe("normalizeSessionEvent", () => {
  test("raw event passthrough with agent id", () => {
    const event = normalizeSessionEvent({
      id: "ScoutA",
      event: { type: "agent_start" },
    });
    expect(event).not.toBeNull();
    expect(event!.agentId).toBe("ScoutA");
    expect(event!.event).toEqual({ type: "agent_start" });
  });

  test("missing id or event returns null", () => {
    expect(normalizeSessionEvent({ id: "A" })).toBeNull();
    expect(normalizeSessionEvent({ event: { type: "x" } })).toBeNull();
    expect(normalizeSessionEvent(null)).toBeNull();
  });
});
