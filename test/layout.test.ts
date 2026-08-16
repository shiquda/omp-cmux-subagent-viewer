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

/** Fake cmux tree: every new-split creates a fresh pane; new-surface adds a tab to the given pane. */
class SplitRunner {
  calls: string[][] = [];
  surfaces: string[] = [];
  panes: string[] = [];
  /** surface ref -> pane ref */
  paneOf = new Map<string, string>();
  surfaceCounter = 100;
  paneCounter = 10;
  callerSurface = "surface:0";

  async exec(argv: string[]): Promise<CommandResult> {
    this.calls.push(argv);
    const cmd = argv[1];
    if (cmd === "identify") {
      return {
        code: 0,
        stdout: JSON.stringify({
          caller: { workspace_ref: "workspace:8", surface_ref: this.callerSurface, pane_ref: "pane:0" },
        }),
        stderr: "",
      };
    }
    if (cmd === "new-split") {
      this.surfaceCounter += 1;
      this.paneCounter += 1;
      const surface = `surface:${this.surfaceCounter}`;
      const pane = `pane:${this.paneCounter}`;
      this.surfaces.push(surface);
      this.panes.push(pane);
      this.paneOf.set(surface, pane);
      return { code: 0, stdout: `OK ${surface} workspace:8\n`, stderr: "" };
    }
    if (cmd === "new-surface") {
      this.surfaceCounter += 1;
      const surface = `surface:${this.surfaceCounter}`;
      const pane = argv[argv.indexOf("--pane") + 1];
      this.surfaces.push(surface);
      this.paneOf.set(surface, pane);
      return { code: 0, stdout: `OK ${surface} workspace:8\n`, stderr: "" };
    }
    if (cmd === "list-panes") {
      return { code: 0, stdout: this.panes.map((p) => `${p}  [1 surface]`).join("\n"), stderr: "" };
    }
    if (cmd === "list-pane-surfaces") {
      const pane = argv[argv.indexOf("--pane") + 1];
      const refs = [...this.paneOf].filter(([, p]) => p === pane).map(([s]) => s);
      return { code: 0, stdout: refs.map((s) => `${s}  Terminal`).join("\n"), stderr: "" };
    }
    if (cmd === "read-screen") {
      return { code: 0, stdout: "➜ repo\n", stderr: "" };
    }
    if (cmd === "close-surface") {
      const target = argv[argv.indexOf("--surface") + 1];
      this.surfaces = this.surfaces.filter((s) => s !== target);
      return { code: 0, stdout: "OK\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  newSplitCalls(): string[][] {
    return this.calls.filter((c) => c[1] === "new-split");
  }
  newSurfaceCalls(): string[][] {
    return this.calls.filter((c) => c[1] === "new-surface");
  }
  closeSurfaceCalls(): string[][] {
    return this.calls.filter((c) => c[1] === "close-surface");
  }
}

function makeSplitLayout(runner: SplitRunner): CmuxLayout {
  const client = new CmuxClient(runner);
  return new CmuxLayout(client, "workspace:8", quietLogger, "split-pane", () => "bun viewer", "/repo");
}

describe("CmuxLayout split-pane placement", () => {
  test("1 agent: full right split from the caller surface", async () => {
    const runner = new SplitRunner();
    const layout = makeSplitLayout(runner);
    const s1 = await layout.ensureSurface(makeView("A"));
    expect(s1).toBe("surface:101");
    const splits = runner.newSplitCalls();
    expect(splits.length).toBe(1);
    expect(splits[0]).toEqual([
      "cmux", "new-split", "right", "--workspace", "workspace:8", "--surface", "surface:0", "--focus", "false",
    ]);
    expect(runner.newSurfaceCalls().length).toBe(0);
    expect(layout.state.splitSurfaces).toEqual(["surface:101"]);
    expect(layout.state.surfaces.get("A")).toBe("surface:101");
  });

  test("2 agents: R1 top + down split R2 bottom", async () => {
    const runner = new SplitRunner();
    const layout = makeSplitLayout(runner);
    await layout.ensureSurface(makeView("A"));
    await layout.ensureSurface(makeView("B"));
    const splits = runner.newSplitCalls();
    expect(splits.length).toBe(2);
    expect(splits[0][2]).toBe("right");
    expect(splits[1].slice(1)).toEqual(["new-split", "down", "--workspace", "workspace:8", "--surface", "surface:101", "--focus", "false"]);
    expect(layout.state.splitSurfaces).toEqual(["surface:101", "surface:102"]);
  });

  test("3 agents: R1 top / R3 middle / R2 bottom — both downs anchored on R1", async () => {
    const runner = new SplitRunner();
    const layout = makeSplitLayout(runner);
    await layout.ensureSurface(makeView("A"));
    await layout.ensureSurface(makeView("B"));
    await layout.ensureSurface(makeView("C"));
    const splits = runner.newSplitCalls();
    expect(splits.length).toBe(3);
    // creation order R1, R2, R3 (visual order is R1, R3, R2)
    expect(layout.state.splitSurfaces).toEqual(["surface:101", "surface:102", "surface:103"]);
    for (const split of splits.slice(1)) {
      expect(split[split.indexOf("--surface") + 1]).toBe("surface:101");
      expect(split[split.indexOf("--focus") + 1]).toBe("false");
    }
    expect(runner.newSurfaceCalls().length).toBe(0);
  });

  test("3 agents spawned in parallel still form a right column (not a horizontal row)", async () => {
    const runner = new SplitRunner();
    const layout = makeSplitLayout(runner);
    // Spawn concurrently — the regression this guards: without serialization,
    // all three observe splitSurfaces.length === 0 and each splits right.
    const [rA, rB, rC] = await Promise.all([
      layout.ensureSurface(makeView("A")),
      layout.ensureSurface(makeView("B")),
      layout.ensureSurface(makeView("C")),
    ]);
    expect(rA).not.toBeNull();
    expect(rB).not.toBeNull();
    expect(rC).not.toBeNull();
    const sA = rA as string;
    const sB = rB as string;
    const sC = rC as string;
    const splits = runner.newSplitCalls();
    expect(splits.length).toBe(3);
    // Exactly one right split (R1); the other two are downs anchored on R1.
    const right = splits.filter((c) => c[2] === "right");
    const downs = splits.filter((c) => c[2] === "down");
    expect(right.length).toBe(1);
    expect(downs.length).toBe(2);
    for (const down of downs) {
      expect(down[down.indexOf("--surface") + 1]).toBe(sA);
    }
    expect(layout.state.splitSurfaces).toEqual([sA, sB, sC]);
  });

  test("4th agent becomes a tab in R1's pane (no fourth split)", async () => {
    const runner = new SplitRunner();
    const layout = makeSplitLayout(runner);
    for (const id of ["A", "B", "C", "D"]) await layout.ensureSurface(makeView(id));
    expect(runner.newSplitCalls().length).toBe(3);
    const tabs = runner.newSurfaceCalls();
    expect(tabs.length).toBe(1);
    // tab lands in R1's pane (pane:11 = the first split's pane)
    expect(tabs[0][tabs[0].indexOf("--pane") + 1]).toBe("pane:11");
    expect(tabs[0][tabs[0].indexOf("--focus") + 1]).toBe("false");
    // tabs are not tracked as splits
    expect(layout.state.splitSurfaces).toEqual(["surface:101", "surface:102", "surface:103"]);
    expect(layout.state.surfaces.get("D")).toBe("surface:104");
  }, 20000);

  test("5th agent adds another tab while splits stay at 3", async () => {
    const runner = new SplitRunner();
    const layout = makeSplitLayout(runner);
    for (const id of ["A", "B", "C", "D", "E"]) await layout.ensureSurface(makeView(id));
    expect(runner.newSplitCalls().length).toBe(3);
    expect(runner.newSurfaceCalls().length).toBe(2);
    expect(layout.state.splitSurfaces).toEqual(["surface:101", "surface:102", "surface:103"]);
  }, 25000);

  test("legacy split mode still surfaces into the caller's pane", async () => {
    const runner = new SplitRunner();
    const client = new CmuxClient(runner);
    const layout = new CmuxLayout(client, "workspace:8", quietLogger, "split", () => "bun viewer", "/repo");
    const s1 = await layout.ensureSurface(makeView("A"));
    expect(s1).toBe("surface:101");
    expect(runner.newSplitCalls().length).toBe(0);
    const tabs = runner.newSurfaceCalls();
    expect(tabs.length).toBe(1);
    expect(tabs[0][tabs[0].indexOf("--pane") + 1]).toBe("pane:0");
  });
});

describe("CmuxLayout split-pane close/forget", () => {
  test("closeSurfaceFor closes, forgets, and drops the split", async () => {
    const runner = new SplitRunner();
    const layout = makeSplitLayout(runner);
    await layout.ensureSurface(makeView("A"));
    await layout.ensureSurface(makeView("B"));
    await layout.ensureSurface(makeView("C"));
    expect(layout.state.splitSurfaces).toEqual(["surface:101", "surface:102", "surface:103"]);

    // B holds R2 (middle split, surface:102)
    expect(await layout.closeSurfaceFor("B")).toBe(true);
    const closes = runner.closeSurfaceCalls();
    expect(closes.length).toBe(1);
    expect(closes[0][closes[0].indexOf("--surface") + 1]).toBe("surface:102");
    expect(layout.state.surfaces.has("B")).toBe(false);
    expect(layout.state.splitSurfaces).toEqual(["surface:101", "surface:103"]);
  });

  test("closeSurfaceFor is idempotent for unknown/gone agents", async () => {
    const runner = new SplitRunner();
    const layout = makeSplitLayout(runner);
    await layout.ensureSurface(makeView("A"));
    expect(await layout.closeSurfaceFor("A")).toBe(true);
    expect(await layout.closeSurfaceFor("A")).toBe(false);
    expect(await layout.closeSurfaceFor("Ghost")).toBe(false);
    expect(runner.closeSurfaceCalls().length).toBe(1);
  });

  test("forgetSurface (user closed) drops the mapping and split", async () => {
    const runner = new SplitRunner();
    const layout = makeSplitLayout(runner);
    await layout.ensureSurface(makeView("A"));
    await layout.ensureSurface(makeView("B"));
    expect(layout.state.splitSurfaces).toEqual(["surface:101", "surface:102"]);
    expect(layout.forgetSurface("A")).toBe(true);
    expect(layout.forgetSurface("A")).toBe(false);
    expect(layout.state.surfaces.has("A")).toBe(false);
    expect(layout.state.splitSurfaces).toEqual(["surface:102"]);
    expect(runner.closeSurfaceCalls().length).toBe(0);
  });
});
