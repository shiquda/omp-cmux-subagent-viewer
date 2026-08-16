// ViewerStream: consume a per-agent JSONL event log with incremental tail.
// Simple and reliable: read whole file, track byte offset, poll every 200ms.
// No fs.watch (append-then-rename races), no daemon — v0.1 transport stays
// plain files per the design doc.

import { readFileSync } from "node:fs";

import type { NormalizedSubagentEvent } from "../extension/types";

export type EventListener = (event: NormalizedSubagentEvent) => void;

export class ViewerStream {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollMs: number;

  constructor(
    private readonly filePath: string,
    private readonly listener: EventListener,
    pollMs = 200,
  ) {
    this.pollMs = pollMs;
  }

  /** Read any pre-existing lines synchronously before start (catches a fast-starting agent). */
  seed(): void {
    this.readOnce();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.readOnce(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private readOnce(): void {
    let content: string;
    try {
      content = readFileSync(this.filePath, "utf8");
    } catch {
      return; // file not created yet (agent not started or dir missing)
    }
    if (content.length <= this.offset) {
      // No new bytes; also handles truncation to empty.
      return;
    }
    if (content.length < this.offset) {
      this.offset = 0; // file was replaced/truncated
    }
    const tail = content.slice(this.offset);
    this.offset = content.length;
    for (const line of tail.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as NormalizedSubagentEvent;
        this.listener(event);
      } catch {
        // partial line mid-write — wait for the next poll to see the rest
      }
    }
  }
}
