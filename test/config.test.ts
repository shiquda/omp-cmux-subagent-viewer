import { describe, expect, test } from "bun:test";

import { loadConfig } from "../extension/config";

describe("loadConfig defaults", () => {
  test("split-pane layout, auto-close on with 5000ms delay", () => {
    const config = loadConfig({});
    expect(config.enabled).toBe(true);
    expect(config.layout).toBe("split-pane");
    expect(config.autoClose).toBe(true);
    expect(config.autoCloseDelayMs).toBe(5000);
    expect(config.keepSurface).toBe(true);
  });
});

describe("loadConfig layout parsing", () => {
  test("accepts all three layout values", () => {
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_LAYOUT: "helper-pane" }).layout).toBe("helper-pane");
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_LAYOUT: "split" }).layout).toBe("split");
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_LAYOUT: "split-pane" }).layout).toBe("split-pane");
  });

  test("unknown layout falls back to split-pane with a warning", () => {
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => warns.push(String(m));
    try {
      const config = loadConfig({ OMP_CMUX_SUBAGENTS_LAYOUT: "bogus" });
      expect(config.layout).toBe("split-pane");
    } finally {
      console.warn = original;
    }
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("unknown layout");
  });
});

describe("loadConfig auto-close parsing", () => {
  test("OMP_CMUX_SUBAGENTS_AUTO_CLOSE accepts bool forms", () => {
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_AUTO_CLOSE: "false" }).autoClose).toBe(false);
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_AUTO_CLOSE: "0" }).autoClose).toBe(false);
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_AUTO_CLOSE: "true" }).autoClose).toBe(true);
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_AUTO_CLOSE: "1" }).autoClose).toBe(true);
  });

  test("OMP_CMUX_SUBAGENTS_AUTO_CLOSE_DELAY_MS parses numbers, falls back on garbage", () => {
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_AUTO_CLOSE_DELAY_MS: "1200" }).autoCloseDelayMs).toBe(1200);
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_AUTO_CLOSE_DELAY_MS: "0" }).autoCloseDelayMs).toBe(0);
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_AUTO_CLOSE_DELAY_MS: "abc" }).autoCloseDelayMs).toBe(5000);
    expect(loadConfig({ OMP_CMUX_SUBAGENTS_AUTO_CLOSE_DELAY_MS: "" }).autoCloseDelayMs).toBe(5000);
  });
});
