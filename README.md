# omp-cmux-subagent-viewer

> Live CMUX surfaces for OMP native subagents — observability, never execution.

Watch [OMP](https://github.com/badlogic/oh-my-pi) native subagents (`task()`) run in real time, in a CMUX helper pane — one terminal surface per agent, without spawning a second agent runtime and without touching task execution.

## Why

When the OMP main agent fans out subagents (`task(agent="scout", …)`, `task(agent="reviewer", …)`), they run headless in-process and you can't see what they're doing until the results come back. This project projects each live subagent into its own CMUX surface so you can watch the transcript as it happens.

```
OMP native task() subagent (in-process AgentSession)
        │  task:subagent:{lifecycle,progress,event}  (parent EventBus)
        ▼
omp extension (pi.events subscription, in-process)
        │  per-agent JSONL + native session transcript
        ▼
CMUX helper pane → one terminal surface per subagent → viewer
```

**Hard constraints honored:**

- Native `task()` semantics untouched — no second agent runtime, no executor replacement, no result-delivery changes.
- CMUX is a projection of in-process OMP subagents, not the owner of them.
- Everything is fail-open: a cmux/viewer hiccup can never affect OMP execution.
- Outside a valid CMUX caller context the extension is a silent no-op.

## Features

- One **helper pane** on the right; one **surface (tab) per subagent** inside it.
- Live turn-by-turn transcript: task, tool calls (args + intent + result), assistant thinking/text, final result.
- Status (`● running` / `✓ completed` / `✗ failed` / `■ aborted`), duration, and a static completed view kept open by default.
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

The first subagent to start creates the helper pane; each subsequent subagent gets its own surface titled `<agentType> · <agentId>`.

### Config (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `OMP_CMUX_SUBAGENTS_ENABLED` | `true` | master switch |
| `OMP_CMUX_SUBAGENTS_LAYOUT` | `helper-pane` | `helper-pane` or `split` (per-agent split fallback) |
| `OMP_CMUX_SUBAGENTS_KEEP_SURFACE` | `true` | keep completed surfaces open |
| `OMP_CMUX_SUBAGENTS_SHOW_DETACHED` | `true` | visualize background/detached agents |
| `OMP_CMUX_SUBAGENTS_DATA_DIR` | `~/.local/state/omp-cmux-subagents` | per-session JSONL root |
| `OMP_CMUX_SUBAGENTS_MAX_EVENTS` | `2000` | viewer history cap |
| `OMP_CMUX_SUBAGENTS_MAX_OUTPUT_LINES` | `1000` | viewer output cap |
| `OMP_CMUX_SUBAGENTS_MAX_LINE_LENGTH` | `400` | line truncation |

## Architecture

```text
extension/            OMP extension — event source → normalizer → registry → JSONL → cmux
  cmux/               cmux CLI client, caller context, helper-pane/surface layout
  normalizer.ts       OMP payload → stable protocol (extension/types.ts)
  agent-view-registry.ts  per-agent state machine (id-keyed, idempotent, concurrency-safe)
  event-writer.ts     per-agent JSONL (0700 dirs / 0600 files)
  event-source.ts     pi.events subscription — the only OMP-specific seam
  index.ts            extension entry — wires everything, fail-open
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
4. Helper-pane layout by default; one surface per agent (not one split each).
5. `--focus false` everywhere — never steal focus.
6. The extension is a projection layer; if the public extension API changes, only `extension/event-source.ts` needs updating (see `docs/omp-integration.md`).

## License

[MIT](./LICENSE) © shiquda
