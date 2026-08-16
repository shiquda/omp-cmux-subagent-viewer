// OMP extension entry: native subagent observability bridge.
//
// Data flow (the invariant that outranks every other detail):
//   OMP native subagent
//     → task:subagent:{lifecycle,progress,event} on parent EventBus
//     → pi.events (this extension subscribes here)
//     → normalizer → normalized protocol (types.ts)
//     → registry (state) + event-writer (JSONL)
//     → cmux layout (helper pane + per-agent surface) → viewer
//
// Hard constraints honored:
//   - never launches a second OMP/pi runtime for subagent work
//   - never replaces/wraps task() or touches AgentRegistry/job manager
//   - subagents stay OMP-owned in-process AgentSessions; CMUX is projection
//   - everything below is fail-open; no failure throws into OMP execution
//   - outside a valid CMUX caller context → disabled/no-op mode (§17)

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig } from "./config";
import { makeSessionRoot } from "./event-writer";
import { EventBusSource } from "./event-source";
import { CmuxClient } from "./cmux/client";
import { detectCallerContext } from "./cmux/context";
import { CmuxLayout } from "./cmux/layout";
import { AgentViewRegistry } from "./agent-view-registry";
import { EventWriter } from "./event-writer";
import type { ExtensionAPI, ExtensionContext } from "./omp-api";
import type { AgentView, ExtensionConfig, LifecycleEvent, NormalizedSubagentEvent } from "./types";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, "..");
const VIEWER_ENTRY = join(repoRoot, "viewer", "index.ts");

const TERMINAL_STATUSES = ["completed", "failed", "aborted"] as const;

/**
 * Per-agent delayed surface close. Timers are unref'd so a pending auto-close
 * never keeps the OMP process alive, and every firing is fail-open.
 */
export class AutoCloseScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(agentId: string, delayMs: number, fn: () => void | Promise<void>): void {
    this.cancel(agentId);
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      try {
        void Promise.resolve(fn());
      } catch (err) {
        // fail-open: a close hiccup must never surface into OMP
        // eslint-disable-next-line no-console
        console.warn(`[cmux-subagents] auto-close failed for ${agentId}: ${(err as Error).message}`);
      }
    }, delayMs);
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  cancel(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(agentId);
  }

  clearAll(): void {
    for (const agentId of [...this.timers.keys()]) this.cancel(agentId);
  }
}

/**
 * Schedule the delayed surface close for a terminal lifecycle event. No-op
 * unless auto-close is enabled and the status is terminal. Exported as a
 * test seam — the pipeline calls this from handleNormalized.
 */
export function maybeScheduleAutoClose(
  event: LifecycleEvent,
  config: ExtensionConfig,
  layout: CmuxLayout,
  autoClose: AutoCloseScheduler,
): void {
  if (!config.autoClose) return;
  if (!(TERMINAL_STATUSES as readonly string[]).includes(event.status)) return;
  autoClose.schedule(event.agentId, config.autoCloseDelayMs, () => {
    layout.closeSurfaceFor(event.agentId);
  });
}

export default function ompCmuxSubagents(api: ExtensionAPI): void {
  const env = process.env as Record<string, string | undefined>;
  const config = loadConfig(env);
  const logger = api.logger;

  if (!config.enabled) {
    logger.info("[cmux-subagents] disabled by config");
    return;
  }

  let ctx: ExtensionContext | undefined;

  api.on("session_start", async (_event, c) => {
    // Every AgentSession fires session_start — including the child sessions
    // of native task() subagents. Only the parent (caller) session owns the
    // subagent event bus; child sessions must not create their own data dirs
    // or surfaces. A child session's file lives inside a parent artifacts
    // dir, next to the parent's own session.jsonl.
    const sessionFile = c.sessionManager.getSessionFile();
    if (sessionFile && existsSync(`${dirname(sessionFile)}.jsonl`)) {
      logger.info("[cmux-subagents] nested session — skipped");
      return;
    }
    ctx = c;
    try {
      await startPipeline(c);
    } catch (err) {
      // fail-open at the top level too
      logger.warn(`[cmux-subagents] startup failed (continuing without surfaces): ${(err as Error).message}`);
    }
  });

  async function startPipeline(c: ExtensionContext): Promise<void> {
    const runner = new BunCommandRunner();
    // Resolve cmux binary: explicit override → bundled app path → PATH.
    // spawn("cmux") depends on PATH, which differs by launch context; the
    // bundled path is always present in CMUX-launched environments.
    const cmuxBin =
      env.CMUX_BIN ??
      env.CMUX_BUNDLED_CLI_PATH ??
      env.CMUX_APP_CLI_PATH ??
      "cmux";
    const client = new CmuxClient(runner, cmuxBin);

    const caller = await detectCallerContext(client, env);
    if (!caller) {
      logger.info("[cmux-subagents] no CMUX caller context — disabled/no-op mode");
      return;
    }

    const sessionId = c.sessionManager.getSessionId();
    if (!sessionId) {
      logger.info("[cmux-subagents] no session id — disabled/no-op mode");
      return;
    }

    const sessionRoot = makeSessionRoot(config.dataDir, sessionId);
    const writer = new EventWriter(sessionRoot, logger);
    writer.ensureDirs();

    const registry = new AgentViewRegistry((agentId) => writer.makeLogPath(agentId));

    const viewerCommand = (view: AgentView): string => {
      const sessionFileArg = view.sessionFile ? ` --session-file ${view.sessionFile}` : "";
      return `bun ${VIEWER_ENTRY} --session ${sessionId} --agent ${view.agentId} --data-dir ${config.dataDir}${sessionFileArg}; echo "[viewer exited]"`;
    };

    const layout = new CmuxLayout(client, caller.workspaceRef, logger, config.layout, viewerCommand, repoRoot);

    const autoClose = new AutoCloseScheduler();

    const source = new EventBusSource(api.events, logger, async (event) => {
      await handleNormalized(event, writer, registry, layout, autoClose, sessionId, caller.workspaceRef, config);
    });
    source.start();
  }
}

/** Process one normalized event: persist to JSONL, update registry, drive CMUX surfaces. Fail-open. */
export async function handleNormalized(
  event: NormalizedSubagentEvent,
  writer: EventWriter,
  registry: AgentViewRegistry,
  layout: CmuxLayout,
  autoClose: AutoCloseScheduler,
  sessionId: string,
  workspace: string,
  config: ExtensionConfig,
): Promise<void> {
  try {
    if (event.type === "lifecycle") {
      const view = registry.applyLifecycle(event);
      if (!view) return;

      if (event.status === "started") {
        if (config.showDetached === false && event.detached === true) {
          // Skip visualization for detached/background agents, still record.
          writer.append(event.agentId, event);
          return;
        }
        writer.append(event.agentId, event);
        const surface = await layout.ensureSurface(view);
        if (surface) {
          registry.attachSurface(event.agentId, surface);
          await layout.renameSurface(view, surface);
        }
        return;
      }

      // Terminal lifecycle: keep the surface open unless auto-close is
      // enabled, in which case close it after the configured delay. The
      // close is idempotent — if the user already closed the surface the
      // timer's closeSurfaceFor no-ops.
      writer.append(event.agentId, event);
      maybeScheduleAutoClose(event, config, layout, autoClose);
      return;
    }

    if (event.type === "progress") {
      registry.applyProgress(event);
      writer.append(event.agentId, event);
      return;
    }

    // session_event — fine-grained raw stream; write through for the viewer.
    writer.append(event.agentId, event);
  } catch (err) {
    // fail-open: a viewer/cmux hiccup must never surface into OMP
    // eslint-disable-next-line no-console
    console.warn(`[cmux-subagents] handle error: ${(err as Error).message}`);
  }
}

/** CommandRunner backed by node child_process (proven available inside the omp extension runtime). */
export class BunCommandRunner {
  async exec(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err: Error) => {
        resolve({ code: -1, stdout, stderr: err.message });
      });
      child.on("close", (code: number | null) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }
}
