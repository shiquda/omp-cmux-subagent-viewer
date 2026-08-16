// CmuxContext: caller-environment probe. Determines whether this OMP session
// runs inside a valid CMUX caller (workspace + surface + socket) and resolves
// the exact workspace/pane/surface refs to anchor the helper pane.
//
// §17: if no valid CMUX caller context, the extension goes disabled/no-op —
// OMP behavior must be identical to not having the extension installed.

import type { CmuxClient } from "./client";

export interface CmuxCallerContext {
  workspaceRef: string;
  surfaceRef?: string;
  paneRef?: string;
  windowRef?: string;
  socketPath?: string;
}

export interface CapabilityProbe {
  helperPaneSupported: boolean;
  surfaceSupported: boolean;
  sendSupported: boolean;
}

export async function detectCallerContext(
  client: CmuxClient,
  env: Record<string, string | undefined>,
): Promise<CmuxCallerContext | null> {
  // Env-derived caller identity first.
  const workspaceRef = env.CMUX_WORKSPACE_ID;
  const surfaceRef = env.CMUX_SURFACE_ID;
  if (!workspaceRef || !surfaceRef) return null;

  const socketPath = env.CMUX_SOCKET_PATH;
  if (!socketPath && !(await client.ping())) return null;

  // Confirm via identify so refs match the live tree. Env carries UUIDs
  // (CMUX_WORKSPACE_ID / CMUX_SURFACE_ID); identify with --id-format both
  // reports the same UUIDs in caller.workspace_id — compare those.
  try {
    const identified = await client.identify();
    if (identified?.caller?.workspace_id && identified.caller.workspace_id !== workspaceRef) {
      return null;
    }
  } catch {
    // identify failure is non-fatal; env refs still usable
  }

  return {
    workspaceRef,
    surfaceRef,
    paneRef: env.CMUX_PANEL_ID,
    socketPath,
  };
}

/** Probe which cmux primitives this build supports (fail-closed to conservative). */
export async function detectCapabilities(client: CmuxClient): Promise<CapabilityProbe> {
  const caps = await client.capabilities();
  return {
    // new-pane/new-surface/send exist on all tested builds; gate on the
    // broadest automation capability as a sanity check only.
    helperPaneSupported: caps.length > 0,
    surfaceSupported: caps.length > 0,
    sendSupported: caps.length > 0,
  };
}
