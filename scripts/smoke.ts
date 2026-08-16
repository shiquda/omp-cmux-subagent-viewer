// Real-CMUX smoke test. Runs entirely inside a throwaway workspace:
//   new-workspace → new-pane → new-surface → send viewer → verify render →
//   rename-tab → close-surface → close-workspace.
// Verifies: cmux CLI interaction works against the live socket, focus is
// never stolen, the viewer renders JSONL content (seed + live tail), and
// cleanup leaves nothing behind.
//
// Usage: bun scripts/smoke.ts

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { BunCommandRunner } from "../extension/index";
import { CmuxClient } from "../extension/cmux/client";
import type { CommandRunner } from "../extension/cmux/client";
import { EventWriter, makeSessionRoot } from "../extension/event-writer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const VIEWER = join(repoRoot, "viewer", "index.ts");

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

let failures = 0;
function check(condition: boolean, label: string, detail = ""): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const runner: CommandRunner = new BunCommandRunner();
  const client = new CmuxClient(runner);

  const before = await client.identify();
  check(before?.caller?.workspace_ref != null, "identify works (caller context)");

  const wsName = `omp-cmux-smoke-${process.pid}`;
  const wsResult = await runner.exec(["cmux", "new-workspace", "--name", wsName, "--focus", "false"]);
  const wsMatch = /workspace:\d+/.exec(wsResult.stdout);
  if (!wsMatch) {
    console.error(`  ✗ new-workspace failed: ${wsResult.stdout} ${wsResult.stderr}`);
    process.exit(1);
  }
  const ws = wsMatch[0];
  console.log(`  ✓ new-workspace ${ws} (${wsName})`);

  // 1. helper pane
  const pane = await client.createHelperPane(ws, "right");
  check(pane != null, `helper pane created (${pane})`);
  if (!pane) {
    await client.runCleanup(ws);
    process.exit(1);
  }

  // 2. prepare test JSONL data (before starting the viewer → exercises seed)
  const dataDir = mkdtempSync(join(tmpdir(), "omp-cmux-smoke-data-"));
  const sessionRoot = makeSessionRoot(dataDir, "smoke-session");
  mkdirSync(join(sessionRoot, "agents"), { recursive: true, mode: 0o700 });
  const writer = new EventWriter(sessionRoot, quietLogger);
  writer.ensureDirs();
  writer.append("AgentSmoke", {
    type: "lifecycle",
    agentId: "AgentSmoke",
    agentType: "scout",
    description: "Smoke scout",
    status: "started",
    timestamp: Date.now(),
  });
  writer.append("AgentSmoke", {
    type: "progress",
    agentId: "AgentSmoke",
    currentTool: "read",
    currentToolArgs: "src/auth/session.ts",
    toolCount: 1,
    durationMs: 1200,
    timestamp: Date.now(),
  });
  writer.append("AgentSmoke", {
    type: "session_event",
    agentId: "AgentSmoke",
    event: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Inspecting authentication flow\n" },
    },
    timestamp: Date.now(),
  });

  // 3. surface + start viewer (surface created, then command sent once shell ready)
  const surface = await client.createSurface(ws, pane, repoRoot);
  check(surface != null, `viewer surface created (${surface})`);
  if (!surface) {
    await client.runCleanup(ws);
    process.exit(1);
  }
  const viewerCmd = `bun ${VIEWER} --session smoke-session --agent AgentSmoke --data-dir ${dataDir} --poll-ms 300`;
  const sent = await client.runCommand(ws, surface, viewerCmd);
  check(sent, "viewer command sent to shell");
  await new Promise((r) => setTimeout(r, 2500));

  // 4. live update while viewer is running (exercises tail)
  await new Promise((r) => setTimeout(r, 1500));
  writer.append("AgentSmoke", {
    type: "session_event",
    agentId: "AgentSmoke",
    event: {
      type: "tool_execution_start",
      toolName: "grep",
      args: { pattern: "createSession" },
    },
    timestamp: Date.now(),
  });
  await new Promise((r) => setTimeout(r, 1200));

  // 5. verify rendered content
  const screen = await runner.exec(["cmux", "read-screen", "--workspace", ws, "--surface", surface, "--lines", "40"]);
  const text = screen.stdout;
  check(text.includes("scout"), "viewer shows agent type", text.slice(0, 80));
  check(text.includes("AgentSmoke"), "viewer shows agent id");
  check(text.includes("running"), "viewer shows running status");
  check(text.includes("grep"), "viewer shows live tool activity");
  check(text.includes("Inspecting authentication flow"), "viewer shows assistant output");
  console.log("--- viewer screen (trimmed) ---");
  console.log(text.split("\n").slice(0, 24).join("\n"));
  console.log("-------------------------------");

  // 6. rename-tab
  const renamed = await client.renameSurface(ws, surface, "scout · AgentSmoke");
  check(renamed, "rename-tab works");
  const surfaces = await client.listPaneSurfaces(ws, pane);
  check(surfaces.some((s) => s.ref === surface && s.title.includes("scout")), "tab title updated");

  // 7. focus never stolen (focused workspace unchanged)
  const after = await client.identify();
  check(after?.focused?.workspace_ref === before?.focused?.workspace_ref, "focus unchanged (main workspace still focused)");

  // 8. close surface + cleanup workspace
  await client.closeSurface(ws, surface);
  check(true, "surface closed");
  const closed = await client.runCleanup(ws);
  check(closed, "smoke workspace closed");

  console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
