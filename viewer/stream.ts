// ViewerStream: consume a per-agent JSONL event log with an incremental tail.
// Read only newly appended bytes so a large historical log cannot be copied
// into memory on every poll. No fs.watch (append-then-rename races), no daemon.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import type { NormalizedSubagentEvent } from "../extension/types";

export type EventListener = (event: NormalizedSubagentEvent) => void;

const READ_CHUNK_BYTES = 64 * 1024;

export class ViewerStream {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollMs: number;
  private decoder = new StringDecoder("utf8");
  private pending = "";

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

  private reset(): void {
    this.offset = 0;
    this.pending = "";
    this.decoder = new StringDecoder("utf8");
  }

  private consume(text: string): void {
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as NormalizedSubagentEvent;
        this.listener(event);
      } catch {
        // Complete but malformed lines are ignored; the next line remains readable.
      }
    }
  }

  private readOnce(): void {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return; // file not created yet (agent not started or dir missing)
    }

    if (size < this.offset) this.reset();
    if (size === this.offset) return;

    let fd: number;
    try {
      fd = openSync(this.filePath, "r");
    } catch {
      return;
    }

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    try {
      while (this.offset < size) {
        const requested = Math.min(buffer.length, size - this.offset);
        const bytesRead = readSync(fd, buffer, 0, requested, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.consume(this.decoder.write(buffer.subarray(0, bytesRead)));
      }
    } finally {
      closeSync(fd);
    }
  }
}
