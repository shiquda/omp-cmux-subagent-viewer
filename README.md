# omp-cmux-subagent-viewer

> Live CMUX surfaces for OMP native subagents — observability, never execution.

<img width="1269" height="945" alt="2026-08-17_15-57-46" src="https://github.com/user-attachments/assets/4db080b0-0a15-4a1d-820b-0e341a075d90" />

Watch [OMP](https://github.com/badlogic/oh-my-pi) native subagents (`task()`) run in real time, projected into CMUX surfaces — right-side splits (or a helper pane with tabs, legacy) — without spawning a second agent runtime and without touching task execution.

## Why

When the OMP main agent fans out subagents (`task(agent="scout", …)`, `task(agent="reviewer", …)`), they run headless in-process and you can't see what they're doing until the results come back. This project projects each live subagent into its own CMUX surface so you can watch the transcript as it happens.

```
OMP native task() subagent (in-process AgentSession)
        │  task:subagent:{lifecycle,progress,event}  (parent EventBus)
        ▼
omp extension (pi.events subscription, in-process)
        │  per-agent JSONL + native session transcript
        ▼
CMUX split column / helper pane → one surface per subagent → viewer
```

**Hard constraints honored:**

- Native `task()` semantics untouched — no second agent runtime, no executor replacement, no result-delivery changes.
- CMUX is a projection of in-process OMP subagents, not the owner of them.
- Everything is fail-open: a cmux/viewer hiccup can never affect OMP execution.
- Outside a valid CMUX caller context the extension is a silent no-op.

## Features

- **split-pane layout (default)** — right-side split column: 1st subagent
  takes the full right side, 2nd splits top/bottom, 3rd top/middle/bottom,
  and every further subagent tabs into the first split's pane. The legacy
  `helper-pane` (one right helper pane, one surface per subagent) is
  retained via `OMP_CMUX_SUBAGENTS_LAYOUT=helper-pane`.
- Live turn-by-turn transcript: task, tool calls (args + intent + result), assistant thinking/text, final result.
- Status (`● running` / `✓ completed` / `✗ failed` / `■ aborted`), duration, and a static completed view kept open by default.
- **Auto-close**: finished agents' surfaces close automatically after a
  configurable delay (default 5 s), keeping the layout tidy without manual
  cleanup. Disable with `OMP_CMUX_SUBAGENTS_AUTO_CLOSE=false`.
- Never steals focus (`--focus false` everywhere); closing a surface does **not** cancel the agent.
- Data source is the subagent's **native session file** (standard OMP session JSONL) — high-fidelity, no custom event dialect in the render path.

## Requirements

- [OMP](https://github.com/badlogic/oh-my-pi) (`omp`) — the coding agent runtime.
- [cmux](https://github.com/cmux-io/cmux) — the terminal multiplexer this integrates with.
- [Bun](https://bun.sh) ≥ 1.3 — runtime for the extension + viewer.

## Install

```bash
git clone https://github.com/shiquda/omp-cmux-subagent-viewer.git
cd omp-cmux-subagent-viewer
bun install

# Load the extension into OMP (symlink the extension/ dir into OMP's user extensions):
ln -sfn "$(pwd)/extension" ~/.omp/agent/extensions/omp-cmux-subagent-viewer
```

Uninstall: `rm ~/.omp/agent/extensions/omp-cmux-subagent-viewer`.

## Use

Start a fresh OMP session (the extension loads on `session_start`) inside CMUX, then spawn native subagents as usual:

```
task(agent="scout", task="…")
task(agent="reviewer", task="…")
```

The first subagent to start splits the right side; each subsequent subagent
gets its own split (up to 3), then tabs into the first split's pane — each
surface titled `<agentType> · <agentId>`. When an agent finishes, its
surface auto-closes after the configured delay (default 5 s).

### Toggle at runtime: `/subagent-viewer`

Inside an OMP session, run `/subagent-viewer` (or `/subagent-viewer on` /
`off`) to globally enable/disable subagent surfaces. The choice is persisted
(marker file under the data dir), so every later session inherits it. The
toggle only gates **new** surface creation — surfaces already open are left
alone. `OMP_CMUX_SUBAGENTS_ENABLED=false` is a hard off (the extension does
not load, so the command is unavailable).

### Config (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `OMP_CMUX_SUBAGENTS_ENABLED` | `true` | master switch |
| `OMP_CMUX_SUBAGENTS_LAYOUT` | `split-pane` | `split-pane` (right split column, default), `helper-pane` (one helper pane), or `split` (legacy per-agent fallback) |
| `OMP_CMUX_SUBAGENTS_KEEP_SURFACE` | `true` | keep completed surfaces open (when auto-close is off) |
| `OMP_CMUX_SUBAGENTS_AUTO_CLOSE` | `true` | close finished agents' surfaces automatically |
| `OMP_CMUX_SUBAGENTS_AUTO_CLOSE_DELAY_MS` | `5000` | delay before auto-closing a finished surface |
| `OMP_CMUX_SUBAGENTS_MAIN_SPLIT_RATIO` | `0.65` | main (left) pane share of the width in split-pane mode; agent column takes the rest |
| `OMP_CMUX_SUBAGENTS_SHOW_DETACHED` | `true` | visualize background/detached agents |
| `OMP_CMUX_SUBAGENTS_DATA_DIR` | `~/.local/state/omp-cmux-subagents` | per-session JSONL root |
| `OMP_CMUX_SUBAGENTS_MAX_EVENTS` | `2000` | viewer history cap |
| `OMP_CMUX_SUBAGENTS_MAX_OUTPUT_LINES` | `1000` | viewer output cap |
| `OMP_CMUX_SUBAGENTS_MAX_LINE_LENGTH` | `400` | line truncation |

## Architecture

```text
extension/            OMP extension — event source → normalizer → registry → JSONL → cmux
  cmux/               cmux CLI client, caller context, split-pane/helper-pane layout
  normalizer.ts       OMP payload → stable protocol (extension/types.ts)
  agent-view-registry.ts  per-agent state machine (id-keyed, idempotent, concurrency-safe)
  event-writer.ts     per-agent JSONL (0700 dirs / 0600 files)
  event-source.ts     pi.events subscription — the only OMP-specific seam
  index.ts            extension entry — wires everything, fail-open; auto-close scheduler
viewer/               standalone terminal viewer (no LLM, no OMP, no tools)
  session-stream.ts   read-side projection of the subagent's native session JSONL
  state.ts            bounded turn-structured display state
  render.ts           ANSI renderer
  index.ts            CLI: --session <id> --agent <id> [--session-file <path>]
test/                 unit + integration (fake bus / fake cmux runner)
scripts/smoke.ts      real-CMUX smoke test (throwaway workspace)
docs/omp-integration.md  Phase 0 probe: payload contracts, cmux CLI quirks, decisions
```

**Protocol boundary.** `extension/types.ts` is the stable contract between the extension (producer) and the viewer (consumer). OMP-specific raw types never leak past `normalizer.ts`. If upstream OMP renames or moves the subagent channels, only `extension/event-source.ts` changes.

## Develop

```bash
bun test                    # unit + integration (fake bus / fake cmux)
bunx tsc --noEmit           # typecheck
bun run scripts/smoke.ts    # real-CMUX smoke: pane → surface → viewer → close
```

## Design constraints

1. OMP owns subagent creation/execution/lifecycle/context/results; CMUX only presents.
2. Never launch a second OMP/pi process for subagent work.
3. Never wrap or replace `task()`; never move subagents into a PTY.
4. Split-pane layout by default (right column: 1 split, 2, 3, then tabs into the first split); helper-pane retained for the legacy one-surface-per-agent model.
5. `--focus false` everywhere — never steal focus.
6. The extension is a projection layer; if the public extension API changes, only `extension/event-source.ts` needs updating (see `docs/omp-integration.md`).

## License

[MIT](./LICENSE) © shiquda
