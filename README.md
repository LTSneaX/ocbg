# ocbg — background jobs for opencode: launch, keep working, get woken on DONE

![version: 2.2.0-r7-turn-firing](https://img.shields.io/badge/version-2.2.0--r7--turn--firing-green) ![license: MIT](https://img.shields.io/badge/license-MIT-blue)

> Long jobs block your session — the agent sits and waits, burning the turn.
> ocbg fixes that: launch it in the background, keep talking, get woken with the result when it lands.

## Contents

- [30-second quickstart](#30-second-quickstart) · [At a glance](#at-a-glance) · [Install](#install)
- [Daily use](#daily-use) · [Tools](#tools) · [Config](#config-reference)
- [What you see](#what-you-see) · [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting) · [Rollback / Uninstall](#rollback--uninstall)
- [Links](#links) · [License](#license)

## 30-second quickstart

```sh
mkdir -p ~/.config/opencode/plugins
cp src/plugin/background.ts ~/.config/opencode/plugins/background.ts
```

SneaX reboots the server (plugins load at boot only), then in any session run `background_config()` — this banner proves you're live:

```
background-ops v2.2.0-r7-turn-firing
```

## At a glance

| | |
|---|---|
| What | One file (`src/plugin/background.ts`) adds background jobs to opencode |
| Tools | 7: run, list, status, read, steer, stop, config |
| Wake + toast | Parent takes a turn on finish; TUI toast in SneaX's voice |
| Logs | `.notifications.log` + `app.log` fire always, even in quiet mode |
| Safety | Two-signal reaper (3m/60s) + owner gate + kill-switches |

## Install

| Method | Command | When |
|---|---|---|
| Copy to plugins (recommended) | `cp src/plugin/background.ts ~/.config/opencode/plugins/background.ts` | Normal deploy — live-only, one file |
| From repo (dev) | Work in `~/projects/ocbg` on `main`, deploy the single file | You're changing the plugin |
| Verify | `background_config()` → `background-ops v2.2.0-r7-turn-firing` banner | After every reboot |

SneaX owns the reboot — agents never restart the server or touch live `plugins/`.
`plugins/` is live-only: backups go to `backups/`, never beside live files (opencode auto-loads every `.ts` in there).

## Daily use

**1. Delegate one job.** You: `background_run(kind="task", prompt="Summarize the repo layout")` → agent-does: returns the id instantly; you keep working, and on finish it takes a turn and reports in its own words. `background_list()` shows `[DONE COMPLETED]`.

**2. Fan out three jobs.** You: three `background_run` calls (tasks or `bash`) → agent-does: all run at once (10 slots, overflow queues in order); each finish wakes a turn and reports. Toasts + `[DONE COMPLETED]` / `[DONE FAILED]` markers stack up in `background_list()`.

**3. Reuse by id.** You: `background_read(id="<job-id>")` → agent-does: prints the full saved result any time, even after restart. `[running]` while active — it never blocks. `background_steer` nudges a live task (max 5, deadline never moves); `background_stop` kills one (partial output kept, `[DONE STOPPED]`).

## Tools

| Tool | When | Key params |
|---|---|---|
| `background_run` | Start a task subagent or shell job | `kind` ("task"\|"bash"), `prompt`, `timeout_minutes`, `notify_on_complete` |
| `background_list` | See everything at a glance | — (shows `[DONE …]` markers) |
| `background_status` | Is it alive right now? | `id` (omit = all running) |
| `background_read` | Full result whenever you like | `id` |
| `background_steer` | Nudge a running task | `id`, `instruction` (max 5, deadline fixed) |
| `background_stop` | Abort it, keep partial output | `id` |
| `background_config` | Banner + live settings (read-only) | — |

Full parameter tables: `docs/api.md`.

## Config reference

| Var | Type | Default | When to touch |
|---|---|---|---|
| `BG_MAX_TIMEOUT_MINUTES` | number | `2880` (48h) | A job legitimately needs >48h |
| `BG_MAX_CONCURRENT_JOBS` | number | `10` | You routinely run >10 |
| `BG_JOB_ID_TYPE` | uuid\|counter\|human | `uuid` | Demo only — others are guessable |
| `BG_MAX_BASH_BYTES` | number | `4096` | Commands rejected and splitting won't do |
| `BG_LIST_CACHE_TTL_MS` | number | `5000` | Never (legacy compat knob) |
| `BG_NOTIFY_DEFAULT` | boolean | `true` | New jobs quiet by default |
| `BG_IDLE_CLOSE_MS` | ms | `180000` (3m) | Good jobs reaped (raise) / dead linger (lower) |
| `BG_WAKE_NOTE` | boolean | `true` (ON) | `false` = zero wake, poll quietly |

```sh
BG_IDLE_CLOSE_MS=180000  # reaper window; SneaX's number — raise if good jobs get reaped
BG_WAKE_NOTE=true        # ON = parent acts on arrival; false = DONE + toast + logs only
```

Set in `~/.config/opencode/.env` before boot. The rest, commented: `docs/config.md`.

## What you see

| State | Toast (verbatim) |
|---|---|
| Done | `✓ done, darling: <id> landed clean` |
| Failed | `✗ broke, honey: <id> exit <code> — come look` |
| Timed out | `⏱ too slow, darling: <id> timed out` |
| Stopped | `■ put down: <id> killed on order` |

Legend: ✓ landed · ✗ broke · ⏱ too slow · ■ put down.
Wake: your session takes an **unprompted turn** on finish — auto-reads and reports (arrival = action, not a bug). `BG_WAKE_NOTE=false` = zero wake, zero residue.
`[DONE COMPLETED]` / `[DONE FAILED]` / `[DONE STOPPED]` markers in `background_list()` are load-bearing — never rename them.
Always-on logs: `.notifications.log` under `~/.local/share/opencode/background-ops/` + structured `app.log` event (service `background-ops`).

## How it works

```
run → id now → child works → sweep sees terminal → notify funnel → parent wakes + reports
```

Results persist on disk (`<id>.md` + `<id>.json`), so they survive restarts and compaction — restart re-reads them.
Reaper: a job dies only when **both** heartbeat AND child/output prove silence for `BG_IDLE_CLOSE_MS` (180000ms = 3m) on a ~60s sweep; any doubt skips to next sweep; reaped closes log quietly, never red.
Guards: owner-only read/steer/stop, immutable deadlines, untrusted-output fences.
Detail: `docs/internals.md` · saga + gates: `docs/history.md`.

## Troubleshooting

- **Edited the file, nothing changed** → new shell ≠ restart; SneaX reboots, then check the banner.
- **Jobs finish silently** → check per-job `notify_on_complete:false`, `BG_NOTIFY_DEFAULT=false`, `BG_WAKE_NOTE=false`; results live in `background_list()` + both logs.
- **Timed out** → `background_read` what's kept, start a fresh run; steer never extends deadlines.
- **Reaper closed a good job** → raise `BG_IDLE_CLOSE_MS`, reboot.
- **Tools missing after a restart** → session model fell back (reduced manifest), not the plugin; restore model, reboot, re-check banner.

Full tree: `docs/troubleshooting.md`.

## Rollback / Uninstall

```sh
rm ~/.config/opencode/plugins/background.ts  # then SneaX reboots; verify tools are gone
```

To restore yesterday: copy the `backups/` file back over `plugins/background.ts` + reboot. Repo history holds every version.

## Links

- `docs/history.md` — the full book, verbatim (base `6cb35dc` on `4ad4612`, live r7)
- `docs/` — `internals.md` · `troubleshooting.md` · `api.md` · `config.md`

## License

MIT. Contributing: change on `main` → `tsc --noEmit` green → commit → push (single-branch, no PRs).
