import { describe, expect, test } from "bun:test";

import { CmuxClient, parsePaneLine, parseSurfaceLine } from "../extension/cmux/client";
import type { CommandResult } from "../extension/cmux/client";

class FakeRunner {
  calls: string[][] = [];
  responses: Map<string, CommandResult> = new Map();

  exec(argv: string[]): Promise<CommandResult> {
    this.calls.push(argv);
    for (const [prefix, result] of this.responses) {
      if (argv.join(" ").startsWith(prefix)) return Promise.resolve(result);
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
}

describe("cmux CLI parsing", () => {
  test("parsePaneLine", () => {
    expect(parsePaneLine("* pane:8  [1 surface]  [focused]")).toEqual({
      ref: "pane:8",
      surfaces: 1,
      focused: true,
    });
    expect(parsePaneLine("  pane:3  [2 surfaces]")).toEqual({ ref: "pane:3", surfaces: 2, focused: false });
    expect(parsePaneLine("garbage")).toBeNull();
  });

  test("parseSurfaceLine", () => {
    expect(parseSurfaceLine("* surface:8  π ⠹ Implement and test paste-1.md  [selected]")).toEqual({
      ref: "surface:8",
      title: "π ⠹ Implement and test paste-1.md",
      selected: true,
    });
    expect(parseSurfaceLine("surface:9  something")).toEqual({ ref: "surface:9", title: "something", selected: false });
  });
});

describe("CmuxClient command construction", () => {
  test("createHelperPane issues new-pane with focus false", async () => {
    const runner = new FakeRunner();
    runner.responses.set("cmux new-pane", { code: 0, stdout: "pane:9\n", stderr: "" });
    const client = new CmuxClient(runner);
    const ref = await client.createHelperPane("workspace:8", "right");
    expect(ref).toBe("pane:9");
    expect(runner.calls[0]).toEqual([
      "cmux", "new-pane", "--type", "terminal", "--direction", "right",
      "--workspace", "workspace:8", "--focus", "false",
    ]);
  });

  test("createSurface issues new-surface with focus false and working-directory", async () => {
    const runner = new FakeRunner();
    runner.responses.set("cmux new-surface", { code: 0, stdout: "surface:10\n", stderr: "" });
    const client = new CmuxClient(runner);
    const ref = await client.createSurface("workspace:8", "pane:9", "/repo");
    expect(ref).toBe("surface:10");
    expect(runner.calls[0]).toEqual([
      "cmux", "new-surface", "--type", "terminal", "--pane", "pane:9",
      "--workspace", "workspace:8", "--working-directory", "/repo", "--focus", "false",
    ]);
    expect(runner.calls.length).toBe(1); // no send yet
  });

  test("runCommand waits for shell then sends", async () => {
    const runner = new FakeRunner();
    runner.responses.set("cmux read-screen", {
      code: 0,
      stdout: "Last login: x\n➜ repo true\n",
      stderr: "",
    });
    runner.responses.set("cmux send", { code: 0, stdout: "", stderr: "" });
    const client = new CmuxClient(runner);
    const ok = await client.runCommand("workspace:8", "surface:10", "bun viewer");
    expect(ok).toBe(true);
    // first a priming send (true), then the real command; both carry an
    // explicit newline so the shell executes them (cmux send has no enter).
    const sends = runner.calls.filter((c) => c[1] === "send");
    expect(sends.length).toBe(2);
    expect(sends[0].includes("true\n")).toBe(true);
    expect(sends[1].includes("bun viewer\n")).toBe(true);
  });

  test("failed command degrades fail-open (no throw into OMP)", async () => {
    const runner = new FakeRunner();
    runner.responses.set("cmux ping", { code: 1, stdout: "", stderr: "socket unavailable" });
    const client = new CmuxClient(runner);
    expect(await client.ping()).toBe(false);
  });

  test("identify surfaces CmuxError when cmux fails", async () => {
    const runner = new FakeRunner();
    runner.responses.set("cmux identify", { code: 1, stdout: "", stderr: "boom" });
    const client = new CmuxClient(runner);
    await expect(client.identify()).rejects.toThrow(/boom/);
  });

  test("identify parses JSON", async () => {
    const runner = new FakeRunner();
    runner.responses.set("cmux identify", {
      code: 0,
      stdout: JSON.stringify({ caller: { workspace_ref: "workspace:8", surface_ref: "surface:8" }, socket_path: "/tmp/s" }),
      stderr: "",
    });
    const client = new CmuxClient(runner);
    const out = await client.identify();
    expect(out?.caller?.workspace_ref).toBe("workspace:8");
    expect(out?.socket_path).toBe("/tmp/s");
  });

  test("identify with invalid JSON returns null (fail-open)", async () => {
    const runner = new FakeRunner();
    runner.responses.set("cmux identify", { code: 0, stdout: "not json", stderr: "" });
    const client = new CmuxClient(runner);
    expect(await client.identify()).toBeNull();
  });
});
