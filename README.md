# ocbg — single background ops for opencode

One manager for async work in [opencode](https://opencode.ai): background **task subagents** + **bash jobs**, completing fully silently.

## Tools

| Tool | Purpose |
|---|---|
| `background_run(kind, prompt, ...)` | Launch task/bash job, returns id immediately |
| `background_list()` | All jobs with titles, summaries, states |
| `background_status(id?)` | Live status, instant |
| `background_read(id)` | Full persisted result |
| `background_steer(id, instruction)` | Follow-up into a running task (resets timeout) |
| `background_stop(id)` | Abort, partial output preserved |

Results persist under `~/.local/share/opencode/background-ops/` and survive restarts/compaction.

## Model

Jobs complete **silently** — no toasts, no injected messages, nothing impersonating the user. Only the agent sees reports (`background_list` flags unread completions) and relays them to the human in its own words.

## Install

Global:

```sh
mkdir -p ~/.config/opencode/plugins
cp src/plugin/background.ts ~/.config/opencode/plugins/background.ts
```

Requires `@opencode-ai/plugin` (already present in standard opencode configs).

## Dev

```sh
npm install
npm run typecheck   # tsc --noEmit
```

MIT.
