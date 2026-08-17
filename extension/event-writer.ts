// EventWriter: append normalized events to per-agent JSONL files under a
// per-session directory. Fail-open: write errors are logged and swallowed —
// native agent execution must never be affected by observability I/O.

import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionLogger } from "./omp-api";
import type { NormalizedSubagentEvent } from "./types";

export const AGENTS_DIR = "agents";
export const METADATA_FILE = "metadata.json";
/** Hard ceiling for one agent's compact event log. */
export const MAX_AGENT_LOG_BYTES = 8 * 1024 * 1024;
const TARGET_AGENT_LOG_BYTES = 6 * 1024 * 1024;

function sessionDirName(sessionId: string): string {
  // Session ids may contain '/' (nested artifact sessions). Collapse to a
  // single path-safe segment so the data root cannot escape into subpaths.
  return sessionId.replace(/[\\/:]/g, "_");
}

function trimAgentLog(filePath: string): void {
  const size = statSync(filePath).size;
  if (size <= MAX_AGENT_LOG_BYTES) return;

  const keepBytes = Math.min(TARGET_AGENT_LOG_BYTES, size);
  const fd = openSync(filePath, "r");
  const tail = Buffer.allocUnsafe(keepBytes);
  try {
    readSync(fd, tail, 0, keepBytes, size - keepBytes);
  } finally {
    closeSync(fd);
  }

  // Start at a complete JSONL record. A temporary file plus rename keeps
  // readers from observing a partially rewritten log.
  const firstLine = tail.indexOf(0x0a);
  const body = firstLine >= 0 ? tail.subarray(firstLine + 1) : Buffer.alloc(0);
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(tempPath, body, { mode: 0o600 });
  renameSync(tempPath, filePath);
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
      const logPath = this.makeLogPath(agentId);
      appendFileSync(logPath, line, { mode: 0o600 });
      if (statSync(logPath).size > MAX_AGENT_LOG_BYTES) trimAgentLog(logPath);
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
