// Auto-close tests: the AutoCloseScheduler unit + pipeline-level verification
// that a terminal lifecycle schedules a delayed close-surface, that
// autoClose=false keeps surfaces, and that a user-closed surface is skipped.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { AutoCloseScheduler, handleNormalized } from "../extension/index";
import { loadConfig } from "../extension/config";
import { EventBusSource } from "../extension/event-source";
import { EventWriter, makeSessionRoot } from "../extension/event-writer";
import { AgentViewRegistry } from "../extension/agent-view-registry";
import { CmuxClient, type CommandResult } from "../extension/cmux/client";
import { CmuxLayout } from "../extension/cmux/layout";
import type { ExtensionEventBus, ExtensionLogger } from "../extension/omp-api";

const quietLogger: ExtensionLogger = { info: () => {}, warn: () => {}, error: () => {} };

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

  closeSurfaceCalls(): string[][] {
    return this.calls.filter((c) => c[1] === "close-surface");
  }
}

function lifecycle(agentId: string, status: string) {
  return { id: agentId, agent: "scout", status, agentSource: "bundled" };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omp-cmux-ac-"));
});

function makePipeline(delayMs: number, autoClose: boolean) {
  const bus = new FakeBus();
  const runner = new RecordingRunner();
  const client = new CmuxClient(runner);
  const sessionRoot = makeSessionRoot(root, "session-ac");
  const writer = new EventWriter(sessionRoot, quietLogger);
  writer.ensureDirs();
  const registry = new AgentViewRegistry((id) => writer.makeLogPath(id));
  const layout = new CmuxLayout(client, "workspace:8", quietLogger, "helper-pane", () => "bun viewer", "/repo");
  const scheduler = new AutoCloseScheduler();
  const config = loadConfig({
    OMP_CMUX_SUBAGENTS_AUTO_CLOSE: String(autoClose),
    OMP_CMUX_SUBAGENTS_AUTO_CLOSE_DELAY_MS: String(delayMs),
  });
  const source = new EventBusSource(bus, quietLogger, async (e) => {
    await handleNormalized(e, writer, registry, layout, scheduler, "session-ac", "workspace:8", config);
  });
  source.start();
  return { bus, runner, layout, scheduler, source, writer };
}

describe("AutoCloseScheduler", () => {
  test("schedule fires the callback after the delay", async () => {
    const scheduler = new AutoCloseScheduler();
    let fired = 0;
    scheduler.schedule("A", 20, () => {
      fired += 1;
    });
    await Bun.sleep(80);
    expect(fired).toBe(1);
    scheduler.clearAll();
  });

  test("cancel prevents firing", async () => {
    const scheduler = new AutoCloseScheduler();
    let fired = 0;
    scheduler.schedule("A", 20, () => {
      fired += 1;
    });
    scheduler.cancel("A");
    await Bun.sleep(80);
    expect(fired).toBe(0);
  });

  test("rescheduling the same agent replaces the pending timer", async () => {
    const scheduler = new AutoCloseScheduler();
    let fired = 0;
    scheduler.schedule("A", 20, () => {
      fired += 1;
    });
    scheduler.schedule("A", 500, () => {
      fired += 1;
    });
    await Bun.sleep(80);
    expect(fired).toBe(0); // first timer canceled, second not due yet
    scheduler.clearAll();
  });
});

describe("auto-close pipeline", () => {
  test("terminal lifecycle closes the surface after the delay", async () => {
    const { bus, runner, source } = makePipeline(30, true);
    bus.emit("task:subagent:lifecycle", lifecycle("A", "started"));
    // wait for surface creation (waitForShell has a 1.5s lead-in)
    await Bun.sleep(2000);
    bus.emit("task:subagent:lifecycle", lifecycle("A", "completed"));
    expect(runner.closeSurfaceCalls().length).toBe(0); // not before the delay
    await Bun.sleep(120);
    const closes = runner.closeSurfaceCalls();
    expect(closes.length).toBe(1);
    expect(closes[0][closes[0].indexOf("--surface") + 1]).toBe("surface:1");
    source.stop();
  });

  test("autoClose=false keeps the surface open", async () => {
    const { bus, runner, source } = makePipeline(30, false);
    bus.emit("task:subagent:lifecycle", lifecycle("A", "started"));
    await Bun.sleep(2000);
    bus.emit("task:subagent:lifecycle", lifecycle("A", "failed"));
    await Bun.sleep(120);
    expect(runner.closeSurfaceCalls().length).toBe(0);
    source.stop();
  });

  test("surface already closed by the user is skipped (idempotent)", async () => {
    const { bus, runner, layout, source } = makePipeline(30, true);
    bus.emit("task:subagent:lifecycle", lifecycle("A", "started"));
    await Bun.sleep(2000);
    // user closes the surface before the auto-close delay elapses
    expect(layout.forgetSurface("A")).toBe(true);
    bus.emit("task:subagent:lifecycle", lifecycle("A", "aborted"));
    await Bun.sleep(120);
    expect(runner.closeSurfaceCalls().length).toBe(0);
    source.stop();
  });

  test("non-terminal lifecycle never schedules a close", async () => {
    const { bus, runner, source } = makePipeline(30, true);
    bus.emit("task:subagent:lifecycle", lifecycle("A", "started"));
    await Bun.sleep(2000);
    bus.emit("task:subagent:lifecycle", lifecycle("A", "started")); // duplicate started
    await Bun.sleep(120);
    expect(runner.closeSurfaceCalls().length).toBe(0);
    source.stop();
  });
});
