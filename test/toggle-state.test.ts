import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { readGlobalEnabled, writeGlobalEnabled } from "../extension/toggle-state";

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe("toggle-state (global persisted on/off)", () => {
  test("defaults to enabled when no marker exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-toggle-"));
    expect(readGlobalEnabled(join(dir, "sub"), quietLogger)).toBe(true);
  });

  test("write false creates the marker; read returns false", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-toggle-"));
    const dataDir = join(dir, "state");
    writeGlobalEnabled(dataDir, false, quietLogger);
    expect(existsSync(join(dataDir, "disabled"))).toBe(true);
    expect(readGlobalEnabled(dataDir, quietLogger)).toBe(false);
  });

  test("write true removes the marker; read returns true (round-trip)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-toggle-"));
    const dataDir = join(dir, "state");
    writeGlobalEnabled(dataDir, false, quietLogger);
    expect(readGlobalEnabled(dataDir, quietLogger)).toBe(false);
    writeGlobalEnabled(dataDir, true, quietLogger);
    expect(existsSync(join(dataDir, "disabled"))).toBe(false);
    expect(readGlobalEnabled(dataDir, quietLogger)).toBe(true);
  });

  test("write true is a no-op when already enabled (no marker to remove)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-toggle-"));
    const dataDir = join(dir, "state");
    writeGlobalEnabled(dataDir, true, quietLogger);
    expect(existsSync(join(dataDir, "disabled"))).toBe(false);
    expect(readGlobalEnabled(dataDir, quietLogger)).toBe(true);
  });

  test("marker content is readable and mode-restricted", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-toggle-"));
    const dataDir = join(dir, "state");
    writeGlobalEnabled(dataDir, false, quietLogger);
    expect(readFileSync(join(dataDir, "disabled"), "utf8")).toBe("off\n");
  });

  test("read on an unreadable path defaults to enabled (fail-open)", () => {
    // A path that cannot be stat'ed as a file (a directory named 'disabled').
    const dir = mkdtempSync(join(tmpdir(), "omp-toggle-"));
    expect(readGlobalEnabled(join(dir, "nonexistent-parent", "x"), quietLogger)).toBe(true);
  });
});
