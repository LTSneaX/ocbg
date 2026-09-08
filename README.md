# ocbg — background jobs for opencode

![version](https://img.shields.io/badge/version-2.2.0--r7--turn--firing-blue)
![license](https://img.shields.io/badge/license-MIT-green)

> Long jobs block the conversation. ocbg fixes that: launch a task or shell command in the background, keep talking, and get a clear signal the moment it lands.

- [30-second quickstart](#30-second-quickstart)
- [At a glance](#at-a-glance)
- [Install](#install)
- [Daily use](#daily-use)
- [Tools](#tools)
- [What you see on finish](#what-you-see-on-finish)
- [How it works](#how-it-works)
- [Config reference](#config-reference)
- [Troubleshooting](#troubleshooting)
- [Rollback / uninstall](#rollback--uninstall)
- [Docs](#docs)
- [License](#license)

## 30-second quickstart

```sh
# 1. Deploy the single file
cp src/plugin/background.ts ~/.config/opencode/plugins/background.ts

# 2. Restart opencode (plugins load at boot only)

# 3. Verify — call the background_config tool. It must print:
# background-ops v2.2.0-r7-turn-firing
```

If the banner shows anything older, the server has not rebooted onto this build yet — restart before trusting anything.

## At a glance

| | |
|---|---|
| **What** | One plugin file that runs tasks and shell commands in the background while the conversation continues |
| **Tools** | 7 tools: run, list, status, read, steer, stop, config |
| **Finish signals** | Wake turn in the transcript + popup toast + `[DONE state]` marker (all on by default, each switchable) |
| **Always-on logs** | `.notifications.log` per project + structured `app.log` event fire on every finish, even quiet ones |
| **Safety nets** | Idle reaper (two-signal, 3-minute default) + owner gate + immutable deadlines + private file permissions |

## Install

| Method | Command | When |
|---|---|---|
| Copy to plugins (recommended) | `cp src/plugin/background.ts ~/.config/opencode/plugins/background.ts` + restart | Normal install and every update |
| From repo (development) | Work in this repo, then copy the single file live as above | Changing the plugin itself |
| Verify | Call `background_config` — banner must read `background-ops v2.2.0-r7-turn-firing` | After every install, update, or restart |

Two rules: plugins load at server boot only (a new file on disk means nothing until restart), and the plugins directory holds only files that must run at boot — keep backups in `backups/` or git history, never beside the live file.

## Daily use

**1. Delegate one long job, keep talking.**

> You: launch the test suite in the background, tell me when it lands.
>
> Agent: starts it with `background_run`, keeps answering other questions. On finish the transcript wakes with the result, the list shows `[DONE COMPLETED]`, and `background_read("<id>")` returns the full output.

**2. Fan out independent work.**

> You: research three options in parallel.
>
> Agent: starts three runs at once (up to 10 concurrent by default; extras queue and start as slots free). Each result arrives with its own finish signal and stays retrievable by id.

**3. Reuse a result by id.**

> You: what did that second job say again?
>
> Agent: `background_read("<id>")` returns the persisted output — finished results survive in per-project storage, so nothing is lost if the moment passes.

## Tools

| Tool | Use it when | Key params |
|---|---|---|
| `background_run` | Start a subagent task or shell command without blocking | `kind` (`task`/`bash`), `prompt`, `timeout_minutes` (default 15), `notify_on_complete` (default true) |
| `background_list` | See every job: id, kind, state, one-line summary | — |
| `background_status` | Check live jobs: heartbeat age, current step, concurrency | `id` (optional; omit for all running) |
| `background_read` | Get the full persisted result of a finished job | `id` |
| `background_steer` | Send a follow-up instruction into a running task (max 5; deadline never moves) | `id`, `instruction` |
| `background_stop` | Abort a running job; partial output is kept | `id` |
| `background_config` | Print current config, limits, and env override names (read-only) | — |

Full parameter tables live in `docs/api.md`.

## What you see on finish

Every finished job emits through one funnel, so natural completions, manual stops, timeouts, and reaper closes all signal the same way:

| State | Toast | List marker |
|---|---|---|
| Completed | Success toast | `[DONE COMPLETED]` |
| Failed | Error toast | `[DONE FAILED]` |
| Timed out | Timeout notice | `[DONE STOPPED]` |
| Stopped | Stopped notice | `[DONE STOPPED]` |

- **Wake turn.** By default the transcript takes an unprompted turn on finish: the result is read and reported in the agent's own words. Set `BG_WAKE_NOTE=false` to skip the wake entirely (zero transcript residue) — toasts, DONE markers, and both logs keep working.
- **Per-job quiet.** Pass `notify_on_complete: false` to silence one job's wake, toast, and DONE marker. The result is still saved, and the file + `app.log` entries still fire.
- **Always-on logs.** `.notifications.log` (JSON lines, per project under `~/.local/share/opencode/background-ops/`) and a structured `app.log` event (`background-ops`) are written on every terminal state, even gated-quiet ones.
- **Timeouts are stops.** A job past its deadline is aborted and reported as stopped with its partial output preserved — steer cannot extend a deadline; start a new run instead.

## How it works

Lifecycle: `run` → live heartbeats per step → terminal funnel (completed / failed / stopped) → uniform notify (logs always, wake + toast + DONE when enabled) → `read` retrieves the persisted result.

- **Persistence.** Each job keeps a Markdown result, a JSON state record, and a heartbeat trail under `~/.local/share/opencode/background-ops/<project>/`, plus one shared `.notifications.log` per project. Finished results stay readable by id.
- **Idle reaper.** About every 60 seconds a sweep checks running jobs. A job closes only when *both* its heartbeat *and* its child/output activity prove silence for the idle window (default 3 minutes). Any doubt skips to the next sweep; a genuine completion that lands mid-sweep always wins.
- **Guards.** Reading, steering, and stopping a job are restricted to the session that created it (anything else gets a fail-closed not-found); lists and status stay visible from any session by design. Deadlines are immutable with a 5-steer cap. Job files are written with private permissions (0700 dirs, 0600 files). Untrusted child output is single-line capped and framed before it reaches summaries or wake text. Starting a background run from inside a background child is rejected — do the work directly instead.
- **Limits.** 10 concurrent jobs (extras queue), 15-minute default timeout (cap 48 hours), 4096-byte shell command cap, random unguessable ids by default.

Details: `docs/internals.md`.

## Config reference

Set in the environment (e.g. `~/.config/opencode/.env`) **before boot**. Defaults suit almost everyone — the "When" column says when to touch one. Source of truth: `CONFIG` in `src/plugin/background.ts`.

| Var | Default | When to touch |
|---|---|---|
| `BG_MAX_TIMEOUT_MINUTES` | `2880` (48h) | A job legitimately needs longer than 48h |
| `BG_MAX_CONCURRENT_JOBS` | `10` | You routinely run more and the machine can take it |
| `BG_JOB_ID_TYPE` | `uuid` | Demo only — `counter`/`human` ids are guessable, never in shared projects |
| `BG_MAX_BASH_BYTES` | `4096` | Commands keep getting rejected and splitting truly does not work |
| `BG_LIST_CACHE_TTL_MS` | `5000` | Never — legacy knob, kept for compatibility |
| `BG_NOTIFY_DEFAULT` | `true` | You want new jobs quiet by default (results are still saved) |
| `BG_IDLE_CLOSE_MS` | `180000` (3m) | Good jobs get reaped (raise it) or dead jobs linger (lower it); bad values fall back to 3m |
| `BG_WAKE_NOTE` | `true` | `false` = no transcript wake; poll via list, toasts, and logs instead |

The two that matter, commented:

```sh
# Reaper idle window: a job closes only when BOTH heartbeat AND child/output
# go silent for this long. Raise it if good jobs get reaped.
BG_IDLE_CLOSE_MS=180000

# Transcript wake: ON = an unprompted turn on finish (arrival = action).
# false = skip the wake entirely (zero residue); DONE + toast + both logs
# keep working, so nothing is lost.
BG_WAKE_NOTE=true
```

Precedence: per-job `notify_on_complete: false` beats global `BG_NOTIFY_DEFAULT=true` for that job; `BG_WAKE_NOTE=false` silences only the wake — toasts, DONE markers, and both logs keep firing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `background_config` shows an old version after updating the file | Restart the server — plugins load at boot only; the file on disk is not the running code until then |
| Jobs finish silently in the transcript | Check `BG_WAKE_NOTE` — when `false`, delivery continues via DONE markers, toasts, and logs; poll with `background_list` / `background_read` |
| A job times out before its work is done | Raise `timeout_minutes` on the next run (within the 48h cap); a timed-out job's partial output is preserved via `background_read` |
| A healthy-looking job was closed as idle | Raise `BG_IDLE_CLOSE_MS`; the reaper only closes on proven silence, but quiet long jobs need a wider window |
| Background tools are missing after a restart | Verify the single file is directly in the plugins directory (no backups beside it) and `background_config` answers; anything else means the boot did not pick it up |

Full decision tree: `docs/troubleshooting.md`.

## Rollback / uninstall

```sh
rm ~/.config/opencode/plugins/background.ts  # then restart; verify the tools are gone via background_config
```

To restore: copy a `backups/` copy (or any repo version) back over `plugins/background.ts` and restart. The repo history holds every version — the repo is the authority, the disk file is just a copy.

## Docs

- `docs/api.md` — full tool parameter reference
- `docs/config.md` — all 8 `BG_` variables in depth
- `docs/internals.md` — lifecycle, reaper, and guards
- `docs/troubleshooting.md` — full troubleshooting tree
- `docs/history.md` — complete project history with version SHAs

## License

MIT.
