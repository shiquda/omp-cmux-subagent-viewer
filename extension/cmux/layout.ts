// CmuxLayout: owns the mapping from subagents to CMUX surfaces.
//
// Two layout families (§8, §15, §13):
// - "helper-pane": one helper pane on the right; one surface (tab) per
//   subagent inside it. First started subagent creates the pane, the rest
//   add surfaces to it.
// - "split": legacy per-agent fallback — each surface lands in the caller's
//   own pane.
// - "split-pane" (default): right-side split column. 1st agent → full-height
//   right split (R1); 2nd → R1 top / R2 bottom; 3rd → R1 top / R3 middle /
//   R2 bottom; 4th+ → extra agents become tabs inside R1's pane.
//
// UX invariants:
// - every create/split/rename/close uses --focus false; never steals focus.
// - surface die ≠ subagent die: closing a surface only removes the view; the
//   native agent keeps running and the view is NOT reopened automatically.
// - failures degrade (no surface), never throw into OMP.

import type { ExtensionLogger } from "../omp-api";
import type { AgentView } from "../types";
import { CmuxClient } from "./client";

export type LayoutMode = "helper-pane" | "split" | "split-pane";

export interface LayoutState {
  helperPane?: string;
  /** agentId -> surface ref */
  surfaces: Map<string, string>;
  /** split-pane mode: right-column split surfaces in creation order (R1 first). */
  splitSurfaces: string[];
}

const HELPER_PANE_TITLE = "subagents";
const MAX_SPLITS = 3;

export class CmuxLayout {
  readonly state: LayoutState = { surfaces: new Map(), splitSurfaces: [] };
  private readonly pendingSurfaces = new Map<string, Promise<string | null>>();
  private pendingHelperPane: Promise<string | null> | null = null;

  constructor(
    private readonly client: CmuxClient,
    private readonly workspace: string,
    private readonly logger: ExtensionLogger,
    private readonly layout: LayoutMode,
    private readonly viewerCommand: (view: AgentView) => string,
    private readonly viewerCwd: string,
  ) {}

  /** Ensure the helper pane exists (idempotent, concurrency-safe). Returns pane ref or null. */
  ensureHelperPane(): Promise<string | null> {
    if (this.pendingHelperPane) return this.pendingHelperPane;
    const creation = this.createHelperPaneInner().finally(() => {
      this.pendingHelperPane = null;
    });
    this.pendingHelperPane = creation;
    return creation;
  }

  private async createHelperPaneInner(): Promise<string | null> {
    // The cached ref may point at a pane the user closed (cmux destroys a
    // pane with its last surface). Verify against the live tree; if gone,
    // recreate. Without this check every later agent would fail to get a
    // surface after the user closes the helper pane once.
    const panes = await this.client.listPanes(this.workspace);
    if (this.state.helperPane && panes.some((p) => p.ref === this.state.helperPane)) {
      return this.state.helperPane;
    }
    this.state.helperPane = undefined;
    const created = await this.client.createHelperPane(this.workspace, "right");
    if (!created) return null;
    this.state.helperPane = created;
    return created;
  }

  /** Create a surface for an agent. Returns surface ref or null. */
  ensureSurface(view: AgentView): Promise<string | null> {
    const existing = this.state.surfaces.get(view.agentId);
    if (existing) return Promise.resolve(existing);
    const pending = this.pendingSurfaces.get(view.agentId);
    if (pending) return pending;
    const creation = this.createSurfaceInner(view).finally(() => {
      this.pendingSurfaces.delete(view.agentId);
    });
    this.pendingSurfaces.set(view.agentId, creation);
    return creation;
  }

  /**
   * Serialize split-pane placement across agents. Without this, N subagents
   * spawned in parallel all observe splitSurfaces.length === 0 before the
   * first split lands, and each splits right from the caller — producing a
   * horizontal row instead of the intended right column. Chaining the
   * placement step makes the length check + split atomic per agent.
   */
  private splitChain: Promise<unknown> = Promise.resolve();

  private enqueueSplitPlacement<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.splitChain.then(fn, fn);
    // Keep the chain alive even when one placement fails.
    this.splitChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async createSurfaceInner(view: AgentView): Promise<string | null> {
    let surface: string | null = null;
    if (this.layout === "split-pane") {
      surface = await this.enqueueSplitPlacement(() => this.createSplitPaneSurface(view));
    } else {
      let pane: string | null = null;
      if (this.layout === "helper-pane") {
        pane = await this.ensureHelperPane();
      }
      if (!pane && this.layout === "split") {
        // split fallback: use the caller surface's pane (the main pane).
        pane = await this.client
          .identify()
          .then((id) => id?.caller?.pane_ref ?? null)
          .catch(() => null);
      }
      if (!pane) return null;
      surface = await this.client.createSurface(this.workspace, pane, this.viewerCwd);
    }
    if (!surface) return null;
    // Launch the viewer only once the interactive shell is ready; a send too
    // early can be swallowed by the login banner.
    await this.client.runCommand(this.workspace, surface, this.viewerCommand(view));
    this.state.surfaces.set(view.agentId, surface);
    return surface;
  }

  /**
   * split-pane placement:
   * - no splits yet → new-split right from the caller surface (R1, full right).
   * - 1-2 splits → new-split down from R1 (R2 bottom; R3 lands middle).
   * - 3 splits → new-surface tab inside R1's pane.
   */
  private async createSplitPaneSurface(view: AgentView): Promise<string | null> {
    const splits = this.state.splitSurfaces;
    if (splits.length === 0) {
      const anchor = await this.client
        .identify()
        .then((id) => id?.caller?.surface_ref ?? null)
        .catch(() => null);
      if (!anchor) return null; // no caller surface to split from — degrade
      const surface = await this.client.newSplit("right", { workspace: this.workspace, surface: anchor });
      if (surface) this.state.splitSurfaces.push(surface);
      return surface;
    }

    const anchor = splits[0]; // R1 stays the split anchor
    if (splits.length < MAX_SPLITS) {
      const surface = await this.client.newSplit("down", { workspace: this.workspace, surface: anchor });
      if (surface) this.state.splitSurfaces.push(surface);
      return surface;
    }

    // 4th+ agent: tab into R1's pane.
    const pane = await this.findPaneForSurface(anchor);
    if (!pane) return null;
    return this.client.createSurface(this.workspace, pane, this.viewerCwd);
  }

  /** Locate the pane that currently holds `surface`. */
  private async findPaneForSurface(surface: string): Promise<string | null> {
    const panes = await this.client.listPanes(this.workspace);
    for (const pane of panes) {
      const surfaces = await this.client.listPaneSurfaces(this.workspace, pane.ref);
      if (surfaces.some((s) => s.ref === surface)) return pane.ref;
    }
    return null;
  }

  /** Best-effort title update. */
  async renameSurface(view: AgentView, surface: string): Promise<void> {
    const title = `${view.agentType} · ${view.agentId}`.slice(0, 60);
    await this.client.renameSurface(this.workspace, surface, title);
  }

  /**
   * Auto-close path: close the agent's surface and forget it. Idempotent —
   * if the surface is already gone (user closed it, timer fired twice) it
   * returns false without issuing a cmux call.
   */
  async closeSurfaceFor(agentId: string): Promise<boolean> {
    const surface = this.state.surfaces.get(agentId);
    if (!surface) return false;
    const closed = await this.client.closeSurface(this.workspace, surface);
    if (closed) {
      this.state.surfaces.delete(agentId);
      this.state.splitSurfaces = this.state.splitSurfaces.filter((s) => s !== surface);
    }
    return closed;
  }

  /** Remove the mapping when the user closed the surface. Returns true if we knew it. */
  forgetSurface(agentId: string): boolean {
    const surface = this.state.surfaces.get(agentId);
    const removed = this.state.surfaces.delete(agentId);
    if (surface) {
      this.state.splitSurfaces = this.state.splitSurfaces.filter((s) => s !== surface);
    }
    return removed;
  }
}
