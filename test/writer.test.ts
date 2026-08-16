import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { EventWriter, makeAgentLogPath, makeSessionRoot } from "../extension/event-writer";
import type { LifecycleEvent, NormalizedSubagentEvent } from "../extension/types";

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omp-cmux-writer-"));
});

afterEach(() => {
  // leave cleanup to OS tmp
});

describe("EventWriter", () => {
  test("append writes one JSON line per event to the agent log", () => {
    const sessionRoot = makeSessionRoot(root, "session-1");
    const writer = new EventWriter(sessionRoot, quietLogger);
    writer.ensureDirs();
    const event: LifecycleEvent = {
      type: "lifecycle",
      agentId: "AgentA",
      agentType: "scout",
      status: "started",
      timestamp: 123,
    };
    expect(writer.append("AgentA", event)).toBe(true);

    const path = writer.makeLogPath("AgentA");
    const content = readFileSync(path, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as NormalizedSubagentEvent;
    expect(parsed.type).toBe("lifecycle");
    expect(parsed.agentId).toBe("AgentA");
  });

  test("session root escapes nested session ids safely", () => {
    const root2 = makeSessionRoot(root, "parent/child");
    expect(root2).not.toContain("/child");
    expect(root2).toBe(join(root, "parent_child"));
  });

  test("agent log path sanitizes agent ids with path separators", () => {
    const p = makeAgentLogPath("/root", "Parent.Child");
    expect(p).toBe("/root/agents/Parent.Child.jsonl");
  });

  test("session dir and agents dir are created with 0700", () => {
    const sessionRoot = makeSessionRoot(root, "session-perm");
    const writer = new EventWriter(sessionRoot, quietLogger);
    writer.ensureDirs();
    const mode = statSync(join(sessionRoot, "agents")).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("writeMetadata persists a metadata.json", () => {
    const sessionRoot = makeSessionRoot(root, "session-meta");
    const writer = new EventWriter(sessionRoot, quietLogger);
    writer.ensureDirs();
    writer.writeMetadata({ session: "s1", agents: 2 });
    const parsed = JSON.parse(readFileSync(join(sessionRoot, "metadata.json"), "utf8"));
    expect(parsed.session).toBe("s1");
    expect(parsed.agents).toBe(2);
  });

  test("append to a missing dir fails open (returns false, no throw)", () => {
    const writer = new EventWriter(join(root, "does-not-exist"), quietLogger);
    const event: LifecycleEvent = {
      type: "lifecycle",
      agentId: "A",
      agentType: "task",
      status: "started",
      timestamp: 1,
    };
    expect(writer.append("A", event)).toBe(false);
  });
});
