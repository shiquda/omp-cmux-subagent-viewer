// CmuxLayout: owns the "one helper pane, one surface per subagent" mapping.
//
// UX invariants (§8, §15, §13):
// - first started subagent creates the right helper pane (if missing), then a
//   surface inside it; subsequent subagents add surfaces to the same pane.
// - every create/rename uses --focus false; never steals user focus.
// - surface die ≠ subagent die: closing a surface only removes the view; the
//   native agent keeps running and the view is NOT reopened automatically.
// - failures degrade (split fallback or no surface), never throw into OMP.

import type { ExtensionLogger } from "../omp-api";
import type { AgentView } from "../types";
import { CmuxClient } from "./client";

export interface LayoutState {
  helperPane?: string;
  /** agentId -> surface ref */
  surfaces: Map<string, string>;
}

const HELPER_PANE_TITLE = "subagents";

export class CmuxLayout {
  readonly state: LayoutState = { surfaces: new Map() };
  private readonly pendingSurfaces = new Map<string, Promise<string | null>>();
  private pendingHelperPane: Promise<string | null> | null = null;

  constructor(
    private readonly client: CmuxClient,
    private readonly workspace: string,
    private readonly logger: ExtensionLogger,
    private readonly layout: "helper-pane" | "split",
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

  /** Create a surface for an agent inside the helper pane (or split fallback). Returns surface ref or null. */
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

  private async createSurfaceInner(view: AgentView): Promise<string | null> {
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

    const surface = await this.client.createSurface(this.workspace, pane, this.viewerCwd);
    if (!surface) return null;
    // Launch the viewer only once the interactive shell is ready; a send too
    // early can be swallowed by the login banner.
    await this.client.runCommand(this.workspace, surface, this.viewerCommand(view));
    this.state.surfaces.set(view.agentId, surface);
    return surface;
  }

  /** Best-effort title update. */
  async renameSurface(view: AgentView, surface: string): Promise<void> {
    const title = `${view.agentType} · ${view.agentId}`.slice(0, 60);
    await this.client.renameSurface(this.workspace, surface, title);
  }

  /** Remove the mapping when the user closed the surface. Returns true if we knew it. */
  forgetSurface(agentId: string): boolean {
    return this.state.surfaces.delete(agentId);
  }
}
