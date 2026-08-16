import { describe, expect, test } from "bun:test";

import { CmuxClient, type CommandResult } from "../extension/cmux/client";
import { CmuxLayout } from "../extension/cmux/layout";
import type { AgentView } from "../extension/types";

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

class PaneRunner {
  calls: string[][] = [];
  panes: string[] = ["pane:1", "pane:2"];
  surfaceCounter = 0;
  paneCounter = 2;

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
      return { code: 0, stdout: this.panes.map((p) => `${p}  [1 surface]`).join("\n"), stderr: "" };
    }
    if (cmd === "read-screen") {
      return { code: 0, stdout: "➜ repo\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

function makeView(agentId: string): AgentView {
  return {
    agentId,
    agentType: "scout",
    status: "started",
    eventLogPath: `/tmp/${agentId}.jsonl`,
    startedAt: 1,
  };
}

describe("CmuxLayout helper pane lifecycle", () => {
  test("cached pane ref that vanished is recreated for the next agent", async () => {
    const runner = new PaneRunner();
    const client = new CmuxClient(runner);
    const layout = new CmuxLayout(client, "workspace:8", quietLogger, "helper-pane", () => "bun viewer", "/repo");

    // First agent creates pane:3 (pane:1/2 exist but are not ours).
    const s1 = await layout.ensureSurface(makeView("A"));
    expect(s1).toBe("surface:1");
    expect(layout.state.helperPane).toBe("pane:3");

    // User closes the helper pane; cmux destroys it. Live tree no longer has pane:3.
    runner.panes = ["pane:1", "pane:2"];

    // Second agent must recreate a pane instead of reusing the dead ref.
    const s2 = await layout.ensureSurface(makeView("B"));
    expect(s2).toBe("surface:2");
    expect(layout.state.helperPane).toBe("pane:4");
    const newPaneCalls = runner.calls.filter((c) => c[1] === "new-pane");
    expect(newPaneCalls.length).toBe(2);
  });

  test("live cached pane is reused without a second new-pane", async () => {
    const runner = new PaneRunner();
    runner.panes = ["pane:1", "pane:2", "pane:3"];
    const client = new CmuxClient(runner);
    const layout = new CmuxLayout(client, "workspace:8", quietLogger, "helper-pane", () => "bun viewer", "/repo");

    await layout.ensureSurface(makeView("A"));
    await layout.ensureSurface(makeView("B"));

    const newPaneCalls = runner.calls.filter((c) => c[1] === "new-pane");
    expect(newPaneCalls.length).toBe(1);
  });
});
