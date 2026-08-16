# OMP ↔ CMUX Subagent Integration — Phase 0 Findings

Verified against `omp 17.3.4` (2026-08-16) and `cmux 0.64.22 (102)`.

## 1. Can an extension subscribe to `task:subagent:*`?

**Yes — via `pi.events`, the shared parent EventBus.** No OMP core patch
needed; the "Preferred path" in the design doc (§5.1) is live.

Empirical probe (extension loaded with `-e`, one native `task()` spawn):

```text
pi.on("task:subagent:lifecycle") → throws: undefined is not an object
                                  (evaluating 'this.extension')
pi.events.on("task:subagent:lifecycle") → receives started/completed events
pi.events.on("task:subagent:progress")  → receives AgentProgress envelopes
pi.events.on("task:subagent:event")     → receives raw AgentSessionEvent
```

`pi.on(...)` only accepts canonical extension event names (`session_start`,
`tool_call`, …) and throws for arbitrary bus channels. The EventBus exposed as
`pi.events` carries the `task:subagent:*` channels verbatim.

## 2. Payload contracts (as observed on the wire)

### lifecycle — `task:subagent:lifecycle`

```jsonc
{
  "id": "DirectoryScout",            // stable agent id (primary key)
  "agent": "scout",                  // agent type
  "agentSource": "bundled",
  "description": "DirectoryScout",   // one-line label (generated)
  "status": "started" | "completed", // started/completed/failed/aborted
  "parentToolCallId": "call_…",
  "detached": true,                  // background vs blocking
  "sessionFile": "…/DirectoryScout.jsonl",
  "index": 0
}
```

### progress — `task:subagent:progress` (envelope)

Outer: `{ index, agent, agentSource, assignment, parentToolCallId, detached,
sessionFile, task, progress }`. Inner `progress` (the `AgentProgress`):

```jsonc
{
  "id": "DirectoryScout",
  "status": "running",
  "currentTool": "grep",             // absent when idle between tools
  "currentToolArgs": "createSession",
  "recentTools": [{ "tool": "read", "args": ".", "endMs": … }],
  "recentOutput": [],
  "toolCount": 3,
  "tokens": 100,
  "durationMs": 1500,
  "requests": 2,
  "modelOverride": null,
  "resolvedModel": "…",
  "resolvedModelIsFallback": false,
  "contextTokens": …, "contextWindow": …, "cost": …
}
```

Note: `currentTool`/`currentToolArgs` are not always populated; fall back to
`tool_execution_start` session events for fine-grained tool activity.

### session_event — `task:subagent:event`

```jsonc
{ "id": "DirectoryScout", "event": { "type": "agent_start" } }
```

Observed event types: `agent_start`, `agent_end`, `turn_start`, `turn_end`,
`message_start`, `message_update` (with `assistantMessageEvent`:
`thinking_start`/`thinking_end`, `text_delta`, `toolcall_start`/`toolcall_delta`/
`toolcall_end`), `message_end`, `tool_execution_start`, `tool_execution_end`.
The same channel also carries subagent session-level events
(`model_changed`, `auto_retry_*`, `todo_reminder`, …).

## 3. What the extension consumes

- `pi.events.on("task:subagent:lifecycle")` → registry + surface creation.
- `pi.events.on("task:subagent:progress")` → running-state + tool display.
- `pi.events.on("task:subagent:event")` → assistant text deltas, tool
  execution, yield result, error extraction.

Compatibility seam: `extension/event-source.ts` is the only module that
mentions the channel names. If upstream renames or moves the channels, only
this file changes.

## 4. CMUX CLI findings

- `cmux new-pane --direction right --workspace W --focus false` → prints
  `OK pane:N`. Focus stays on the caller (verified: `identify` focused
  workspace unchanged after creation).
- `cmux new-surface --type terminal --pane P --workspace W --working-directory
  D --focus false` → prints `OK surface:N`.
- **`cmux send` does NOT append Enter.** Text is typed but not executed; every
  command must carry an explicit `\n` escape. Discovered empirically: `send
  "true"` left the command unexecuted; `send "true\n"` executed it.
- Backdrop surfaces render lazily: immediately after creation,
  `read-screen` returns `Error: internal_error: Failed to read terminal text`.
  Sending any input (`send "true\n"`) forces rendering, after which
  `read-screen` works. A fixed 1.5 s lead-in before the probe send, then
  polling for a prompt character (`➜ ❯ ❮ %`), is the reliable readiness check.
- `cmux rename-tab --surface S <title>` and `cmux close-surface --surface S`
  behave as documented.
- `workspace:9`-style refs are stable across commands; `identify --json`
  reports `caller.workspace_ref` / `caller.surface_ref` / `caller.pane_ref`.

## 5. Decision log

| Question | Decision |
| --- | --- |
| Subscription path | `pi.events.on(...)` (bus), not `pi.on(...)` |
| OMP core patch | Not required (v17.3.4) — no `compatibility.ts` needed yet |
| Transport | JSONL per-agent files under `$DATA_DIR/<session>/agents/` |
| Surface launch | `createSurface` + `waitForShell` + `send "<cmd>\n"` |
| Focus | Every create/rename uses `--focus false`; verified no focus change |
| Viewer terminal state | Exits after `completed/failed/aborted` render |
| Surface close | Only forgets the mapping; native agent untouched |

## 6. Residual risks

- `currentTool` is sparse in progress envelopes; the viewer prefers
  `tool_execution_start` events for tool display.
- Nested subagents emit flat events today; no reliable parent-child identity
  in the payload — flat display only (per design §14).
- Extension runs in-process; all cmux/writer paths are fail-open and wrapped,
  so a cmux/viewer failure cannot affect OMP execution (verified by the
  integration test's garbage-payload case and the fail-open writer tests).
