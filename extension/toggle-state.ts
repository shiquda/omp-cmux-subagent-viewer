// Global on/off switch for subagent surfaces, persisted across sessions.
//
// Design: a single marker file `<dataDir>/disabled` — present means the
// viewer is globally off, absent means on. Deliberately a file (not env, not
// config.yml) so the /subagent-viewer slash command can flip it at runtime
// and every subsequent session picks it up. Read once at session start; the
// runtime toggle only gates new surface creation, never touches surfaces
// that are already open. All IO is fail-open.

import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionLogger } from "./omp-api";

const MARKER = "disabled";

function markerPath(dataDir: string): string {
  return join(dataDir, MARKER);
}

/** Read the persisted global switch. Defaults to enabled on any doubt. */
export function readGlobalEnabled(dataDir: string, logger?: ExtensionLogger): boolean {
  try {
    return !existsSync(markerPath(dataDir));
  } catch (err) {
    logger?.warn(`[cmux-subagents] toggle read failed (defaulting on): ${(err as Error).message}`);
    return true;
  }
}

/** Persist the global switch. Best-effort; never throws. */
export function writeGlobalEnabled(dataDir: string, enabled: boolean, logger?: ExtensionLogger): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = markerPath(dataDir);
    if (enabled) {
      if (existsSync(path)) rmSync(path);
    } else {
      writeFileSync(path, "off\n", { mode: 0o600 });
    }
  } catch (err) {
    logger?.warn(`[cmux-subagents] toggle write failed: ${(err as Error).message}`);
  }
}
