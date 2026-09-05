# ocbg — background operations plugin for opencode

Async task subagents + bash jobs for [opencode](https://opencode.ai): launch work, keep going, read results when ready.

## Features (proven live)

7 tools, single-file install (`src/plugin/background.ts`):

| Tool | Purpose |
|---|---|
| `background_run(kind, prompt, ...)` | Launch a `task` subagent or `bash` job, returns id immediately |
| `background_list()` | All jobs with titles, summaries, states |
| `background_status(id?)` | Live status with heartbeat age + current step, instant |
| `background_read(id)` | Full persisted result |
| `background_steer(id, instruction)` | Follow-up instruction into a running task (extends timeout) |
| `background_stop(id)` | Abort a running job, partial output preserved |
| `background_config()` | Print current CONFIG (timeout cap, concurrency, jobIdType, limits) — read-only |

- **Completion detection, noisy-by-default:** completions surface `[DONE state]` markers visible in `background_list`. The agent owns reporting — it relays results to the human in its own words.
- **Uniform notify:** every job carries the same completion notification path; no silent completions.
- **Errors-only stderr:** successes stay silent on stderr; failures and stops still log.
- **Toast + ping wake:** completed jobs wake the session so results are never missed.
- **Idle reaper:** jobs silent on both signals (stale heartbeat AND stale child/output activity) for ≥180s (`BG_IDLE_CLOSE_MS`, default 180000ms) are auto-closed on a ~60s sweep. Override via `~/.config/opencode/.env` with `BG_IDLE_CLOSE_MS=<ms>`.
- **Durable results:** job output persists under `~/.local/share/opencode/background-ops/` and survives restarts/compaction.

## Install

1. Create the live plugins dir and copy the single file:

```sh
mkdir -p ~/.config/opencode/plugins
cp src/plugin/background.ts ~/.config/opencode/plugins/background.ts
```

2. Register it in your global `opencode.json` (single-hunk addition to the `plugin` array — see `opencode.json.example`):

```json
{
  "plugin": [
    "./plugins/background.ts"
  ]
}
```

3. Restart opencode (restart is owned by the user — agents never restart it).
4. Verify:

```sh
# inside an opencode session, call:
background_config()
```

Requires `@opencode-ai/plugin` (already present in standard opencode configs).

## Usage

Launch a background subagent task:

```
background_run(kind="task", prompt="Summarize the repo layout")
```

Launch a background shell job:

```
background_run(kind="bash", prompt="npm test 2>&1 | tail -20")
```

Read the full result when ready:

```
background_read(id="<job-id>")
```

Check everything at a glance:

```
background_list()
```

Live heartbeat check:

```
background_status(id="<job-id>")
```

## Version history

- **v2.1.0 (proven base):** idle reaper with two-signal close (stale heartbeat AND provable child/output silence) + partial-output preservation on stop. Race-safe stop path, per-job error isolation.
- **v2.2.0 (completion + notify):** rebuilt task-completion detection (noisy-by-default `[DONE state]` markers) + uniform notify with toast + ping wake.
- **r3-red (red-fix on v2.2.0 bytes):** errors-only stderr gate — successes silent, failures/stops still log.

## License / status

MIT. Status: proven live, SneaX-witnessed Sept 5 2026.
