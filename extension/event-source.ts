// EventSource: subscribe to OMP's parent EventBus channels for native
// subagent events and forward normalized events to the pipeline.
//
// Preferred path (verified against omp 17.3.4): `pi.events` IS the shared
// parent EventBus and carries task:subagent:lifecycle / progress / event.
// `pi.on(...)` only accepts canonical extension event names, so we bind via
// `pi.events.on(...)` directly. No OMP core patch required — this layer is
// the compatibility seam if upstream ever renames channels.

import { isSubagentChannel, normalizeChannelEvent } from "./normalizer";
import type { ExtensionEventBus, ExtensionLogger } from "./omp-api";
import type { NormalizedSubagentEvent } from "./types";

export interface SubagentEventSource {
  start(): void;
  stop(): void;
}

export class EventBusSource implements SubagentEventSource {
  private readonly bound: Array<{ channel: string; handler: (payload: unknown) => void }> = [];
  private active = false;

  constructor(
    private readonly bus: ExtensionEventBus,
    private readonly logger: ExtensionLogger,
    private readonly handler: (event: NormalizedSubagentEvent) => void,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    for (const channel of ["task:subagent:lifecycle", "task:subagent:progress", "task:subagent:event"]) {
      const wrapped = (payload: unknown) => {
        try {
          if (!isSubagentChannel(channel)) return;
          const normalized = normalizeChannelEvent(channel, payload);
          if (normalized) this.handler(normalized);
        } catch (err) {
          // fail-open: never let observability parsing crash the session
          this.logger.warn(`[cmux-subagents] event handling failed on ${channel}: ${(err as Error).message}`);
        }
      };
      try {
        this.bus.on(channel, wrapped);
        this.bound.push({ channel, handler: wrapped });
      } catch (err) {
        this.logger.warn(`[cmux-subagents] cannot subscribe to ${channel}: ${(err as Error).message}`);
      }
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const { channel, handler } of this.bound) {
      try {
        const bus = this.bus as ExtensionEventBus & {
          off?(channel: string, h: (payload: unknown) => void): unknown;
          removeListener?(channel: string, h: (payload: unknown) => void): unknown;
        };
        if (typeof bus.off === "function") bus.off(channel, handler);
        else if (typeof bus.removeListener === "function") bus.removeListener(channel, handler);
      } catch (err) {
        this.logger.warn(`[cmux-subagents] unsubscribe ${channel} failed: ${(err as Error).message}`);
      }
    }
    this.bound.length = 0;
  }
}
