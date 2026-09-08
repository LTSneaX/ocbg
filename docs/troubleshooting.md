# ocbg troubleshooting — full tree

> README keeps the 5 common fixes; this is the whole tree. Live proof recipe: `docs/history.md` H9.

## Stale runtime (edited the file, nothing changed)

New shell ≠ restart — the plugin loads at server boot only. Copy the file live, have SneaX reboot, then `background_config()` must print `background-ops v2.2.0-r7-turn-firing`. Anything older = still on the old build, stop and reboot before testing further.

## Jobs finish silently (nobody tells you)

Two switches: per-job `notify_on_complete:false` silences that one job; `BG_NOTIFY_DEFAULT=false` silences all *new* jobs by default. `BG_WAKE_NOTE=false` kills the wake message entirely while leaving toast + DONE + logs + polling alive. Results are never lost: `background_list()` shows `[DONE …]` markers; `.notifications.log` + `app.log` always fire.

## Timeout (`⏱ too slow, darling: <id> timed out`)

Ran past its deadline (cap `BG_MAX_TIMEOUT_MINUTES`, default 48h). Whatever it produced is kept — `background_read` it, then start a fresh run for the remainder. `background_steer` never extends the deadline.

## Reaped as stale (reaper closed a good job)

The reaper needs *both* signals silent for `BG_IDLE_CLOSE_MS` (default 3m) — see `docs/internals.md`. If good jobs keep getting reaped, raise `BG_IDLE_CLOSE_MS` in `~/.config/opencode/.env` and reboot. Reaped closes are routine and quiet by design (log line only, never red).

## Tools missing after a model switch

If `background_*` tools vanish after a restart, the session model likely fell back (reduced tool manifest) — not a plugin problem. The file on disk is untouched; results persist. Restore the session model, reboot via SneaX, and re-check the `background_config()` banner.

## Nested-run rejection

`background_run is disabled inside background children` — do the work directly with read/edit/bash. This blocks fork-bombs; restructure instead of retrying.

## Owner-gate not-found

`No job <id>` on read/steer/stop usually means a different session created it (L1 owner gate, fail-closed) — check `background_list()` (global) and run the op from the owning session.

## Want yesterday back

See README Rollback/Uninstall: copy the `backups/` file back over `~/.config/opencode/plugins/background.ts` + SneaX reboot. Never store backups inside `plugins/`.
