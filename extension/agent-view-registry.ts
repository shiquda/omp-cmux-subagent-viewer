// AgentViewRegistry: per-native-subagent state, keyed by the stable OMP agent
// id (primary key — agent type/name is NOT unique; several same-type agents
// can coexist). Handles lifecycle transitions and duplicate-event idempotency.

import type { AgentView, AgentViewStatus, LifecycleEvent, ProgressEvent } from "./types";

const TERMINAL: readonly AgentViewStatus[] = ["completed", "failed", "aborted"];

export class AgentViewRegistry {
  private readonly views = new Map<string, AgentView>();
  private readonly order: string[] = [];

  constructor(
    private readonly makeLogPath: (agentId: string) => string,
    private readonly onNewAgent?: (view: AgentView) => void,
  ) {}

  get(agentId: string): AgentView | undefined {
    return this.views.get(agentId);
  }

  all(): AgentView[] {
    return this.order.map((id) => this.views.get(id)!).filter(Boolean);
  }

  size(): number {
    return this.views.size;
  }

  /** Handle a normalized lifecycle event. Returns the affected view, or null when ignored (e.g. terminal after terminal). */
  applyLifecycle(event: LifecycleEvent): AgentView | null {
    let view = this.views.get(event.agentId);
    if (!view) {
      if (event.status !== "started") return null; // never saw a start
      view = {
        agentId: event.agentId,
        agentType: event.agentType,
        description: event.description,
        status: "started",
        eventLogPath: this.makeLogPath(event.agentId),
        startedAt: event.timestamp,
        sessionFile: event.sessionFile,
        parentToolCallId: event.parentToolCallId,
        detached: event.detached,
        index: event.index,
      };
      this.views.set(view.agentId, view);
      this.order.push(view.agentId);
      this.onNewAgent?.(view);
      return view;
    }

    if (view.status === event.status) return view; // idempotent duplicate
    if (TERMINAL.includes(view.status) && TERMINAL.includes(event.status)) {
      // Duplicate/out-of-order terminal: keep the first terminal, refresh timestamp.
      view.completedAt = event.timestamp;
      return view;
    }

    view.status = event.status;
    if (event.description !== undefined) view.description = event.description;
    if (event.sessionFile !== undefined) view.sessionFile = event.sessionFile;
    if (event.detached !== undefined) view.detached = event.detached;
    if (event.index !== undefined) view.index = event.index;
    if (TERMINAL.includes(view.status)) view.completedAt = event.timestamp;
    return view;
  }

  /** Handle a normalized progress event. A progress after started flips the view to running (idempotent). */
  applyProgress(event: ProgressEvent): AgentView | null {
    const view = this.views.get(event.agentId);
    if (!view) return null; // progress before lifecycle start — ignore
    if (view.status === "started") view.status = "running";
    return view;
  }

  /** Record a CMUX surface ref against a view. Returns false when the view is gone. */
  attachSurface(agentId: string, surfaceId: string): boolean {
    const view = this.views.get(agentId);
    if (!view) return false;
    view.cmuxSurfaceId = surfaceId;
    return true;
  }
}
