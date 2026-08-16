// EventWriter: append normalized events to per-agent JSONL files under a
// per-session directory. Fail-open: write errors are logged and swallowed —
// native agent execution must never be affected by observability I/O.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionLogger } from "./omp-api";
import type { NormalizedSubagentEvent } from "./types";

export const AGENTS_DIR = "agents";
export const METADATA_FILE = "metadata.json";

function sessionDirName(sessionId: string): string {
  // Session ids may contain '/' (nested artifact sessions). Collapse to a
  // single path-safe segment so the data root cannot escape into subpaths.
  return sessionId.replace(/[\\/:]/g, "_");
}

export function makeSessionRoot(dataRoot: string, sessionId: string): string {
  return join(dataRoot, sessionDirName(sessionId));
}

export function makeAgentLogPath(sessionRoot: string, agentId: string): string {
  return join(sessionRoot, AGENTS_DIR, `${agentId.replace(/[\\/:]/g, "_")}.jsonl`);
}

export class EventWriter {
  private sessionRoot: string;
  private initError?: string;

  constructor(
    sessionRoot: string,
    private readonly logger: ExtensionLogger,
  ) {
    this.sessionRoot = sessionRoot;
  }

  /** Create session dir (0700) and agents dir. Safe to call repeatedly. */
  ensureDirs(): void {
    try {
      mkdirSync(join(this.sessionRoot, AGENTS_DIR), { recursive: true, mode: 0o700 });
      mkdirSync(this.sessionRoot, { recursive: true, mode: 0o700 });
      this.initError = undefined;
    } catch (err) {
      // Cache the root cause: later appends fail with ENOENT, which alone is
      // misleading. Keep fail-open (never throw), but retain the original error.
      this.initError = (err as Error).message;
      this.logger.warn(`[cmux-subagents] mkdir failed: ${this.initError}`);
    }
  }

  append(agentId: string, event: NormalizedSubagentEvent): boolean {
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch {
      this.logger.warn(`[cmux-subagents] event serialization failed for ${agentId}`);
      return false;
    }
    try {
      appendFileSync(this.makeLogPath(agentId), line, { mode: 0o600 });
      return true;
    } catch (err) {
      const cause = this.initError ? ` (root cause: ${this.initError})` : "";
      this.logger.warn(`[cmux-subagents] append failed for ${agentId}: ${(err as Error).message}${cause}`);
      return false;
    }
  }

  /** Write a metadata.json with 0600 for the session (best-effort). */
  writeMetadata(metadata: Record<string, unknown>): void {
    try {
      const file = join(this.sessionRoot, METADATA_FILE);
      // Rewrite the whole file so stale keys (e.g. completedAt) never linger.
      const content = JSON.stringify(metadata, null, 2);
      writeFileSync(file, `${content}\n`, { mode: 0o600 });
    } catch (err) {
      this.logger.warn(`[cmux-subagents] metadata write failed: ${(err as Error).message}`);
    }
  }

  /** Absolute path to an agent's JSONL. */
  makeLogPath(agentId: string): string {
    return makeAgentLogPath(this.sessionRoot, agentId);
  }
}
