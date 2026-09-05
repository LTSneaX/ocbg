# ocbg — single background ops for opencode

One manager for async work in [opencode](https://opencode.ai): background **task subagents** + **bash jobs** (v2.2.0-r3-red: errors-only stderr — failures/stops log, successes silent).

## Tools (7)

| Tool | Purpose |
|---|---|
| `background_run(kind, prompt, ...)` | Launch task/bash job, returns id immediately |
| `background_list()` | All jobs with titles, summaries, states |
| `background_status(id?)` | Live status with heartbeat age, instant |
| `background_read(id)` | Full persisted result |
| `background_steer(id, instruction)` | Follow-up into a running task (resets timeout) |
| `background_stop(id)` | Abort, partial output preserved |
| `background_config()` | Print current CONFIG (timeout cap, concurrency, jobIdType, limits) — read-only |

Results persist under `~/.local/share/opencode/background-ops/` and survive restarts/compaction.

## Model

Jobs complete **noisy-by-default** — completions include `[DONE state]` markers visible in `background_list`. Live heartbeats are visible in `background_status` (heartbeat age per job). The agent owns reporting: it relays results to the human in its own words.

**Idle reaper:** jobs silent for ≥180s (`BG_IDLE_CLOSE_MS`, default 180000ms = 3m, overridable via `~/.config/opencode/.env`) are auto-closed on a ~60s sweep cadence. Sweep only evaluates; close still requires the full idle window on both signals (stale heartbeat AND stale child/output activity).

**R3 red-fix:** successes silent on stderr, failures/stops still log.

## Install (explicit registration)

Global `opencode.json` — the plugin array must include the background entry (single-hunk addition):

```json
{
  "plugin": [
    "./plugin/mavis-hooks.ts",
    "./hooks/kill-switch.sh",
    "./hooks/steer.sh",
    "./plugins/background.ts"
  ]
}
```

See `opencode.json.example` in this repo. Copy the plugin file:

```sh
mkdir -p ~/.config/opencode/plugins
cp src/plugin/background.ts ~/.config/opencode/plugins/background.ts
```

Requires `@opencode-ai/plugin` (already present in standard opencode configs).

## Dev

```sh
npm install
npm run typecheck   # tsc --noEmit
node --check src/plugin/background.ts
```

MIT.
