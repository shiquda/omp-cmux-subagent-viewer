#!/usr/bin/env bun
// omp-subagent-viewer: standalone terminal viewer for one native subagent.
//
// Not an agent: no LLM, no OMP, no AgentSession, no tools. It reads the
// extension's JSONL presentation stream for a session+agent and renders a
// live bounded view. Exits when the agent reaches a terminal state (or the
// stream ends and the file stops growing).
//
// Usage: bun viewer/index.ts --session <session-id> --agent <agent-id>
//        [--data-dir <root>] [--lines <n>] [--poll-ms <n>] [--no-live]

import { homedir } from "node:os";
import { join } from "node:path";

import { makeAgentLogPath } from "../extension/event-writer";
import type { NormalizedSubagentEvent } from "../extension/types";
import { renderClear } from "./render";
import { readSessionFileTail, sessionMessageToEvent } from "./session-stream";
import { applyEvent, createViewerState } from "./state";
import { ViewerStream } from "./stream";

interface CliArgs {
  session: string;
  agent: string;
  sessionFile: string;
  dataDir: string;
  maxOutputLines: number;
  pollMs: number;
  noLive: boolean;
}

function fail(message: string): never {
  console.error(`omp-subagent-viewer: ${message}`);
  process.exit(2);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    session: "",
    agent: "",
    sessionFile: "",
    dataDir: join(homedir(), ".local", "state", "omp-cmux-subagents"),
    maxOutputLines: 1000,
    pollMs: 200,
    noLive: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) fail(`missing value for ${arg}`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--session":
        args.session = next();
        break;
      case "--agent":
        args.agent = next();
        break;
      case "--session-file":
        args.sessionFile = next();
        break;
      case "--data-dir":
        args.dataDir = next();
        break;
      case "--lines":
        args.maxOutputLines = Number(next()) || 1000;
        break;
      case "--poll-ms":
        args.pollMs = Number(next()) || 200;
        break;
      case "--no-live":
        args.noLive = true;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!args.session || !args.agent) fail("--session and --agent are required");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve the session dir exactly like the extension does (session ids may
  // contain path separators for nested sessions).
  const sessionSegment = args.session.replace(/[\\/:]/g, "_");
  const sessionRoot = join(args.dataDir, sessionSegment);
  const logPath = makeAgentLogPath(sessionRoot, args.agent);

  const state = createViewerState(args.agent, "subagent");
  let dirty = true;
  let lastFrame: string | undefined;
  // Extension stream: lifecycle/progress + raw session events (tool display).
  const stream = new ViewerStream(logPath, (event: NormalizedSubagentEvent) => {
    applyEvent(state, event);
    dirty = true;
  }, args.pollMs);

  // Native transcript: tail the subagent's session file (standard OMP session
  // JSONL) and fold its messages into turns. This is the "native data" path —
  // higher fidelity than the progress summary.
  let sessionOffset = 0;
  const readSession = (): void => {
    if (!args.sessionFile) return;
    const result = readSessionFileTail(args.sessionFile, sessionOffset);
    if (result.reset) {
      state.turns.length = 0;
      state.recentTools.length = 0;
    }
    sessionOffset = result.nextOffset;
    for (const message of result.messages) {
      applyEvent(state, sessionMessageToEvent(args.agent, message));
    }
    if (result.reset || result.messages.length > 0) dirty = true;
  };

  stream.seed();
  readSession();

  const terminalStates = new Set(["completed", "failed", "aborted"]);
  const render = (force = false): void => {
    if (!force && !dirty) return;
    const frame = renderClear(state);
    dirty = false;
    if (!force && frame === lastFrame) return;
    process.stdout.write(frame);
    lastFrame = frame;
  };

  if (args.noLive) {
    render(true);
    stream.stop();
    process.exit(0);
  }

  stream.start();
  render(true);

  const timer = setInterval(() => {
    readSession();
    render();
    if (terminalStates.has(state.status)) {
      stream.stop();
      clearInterval(timer);
      process.exit(0);
    }
  }, args.pollMs);

  process.on("SIGINT", () => {
    stream.stop();
    clearInterval(timer);
    process.exit(0);
  });
}

await main();
