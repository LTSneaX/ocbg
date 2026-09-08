# ocbg API — full tool parameters

> Source of truth is `src/plugin/background.ts`. This page mirrors the tool schemas; if in doubt, read the code.

## background_run(kind, prompt, ...)

Launch a `task` subagent or `bash` job. Returns the id immediately — never blocks.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `kind` | `"task"` \| `"bash"` | yes | `task` = subagent, `bash` = shell |
| `prompt` | string | yes | Task prompt OR shell command (bash capped at `BG_MAX_BASH_BYTES`) |
| `agent` | string | no | Subagent name |
| `timeout_minutes` | number | no | Default 1440 (24h); clamped to `BG_MAX_TIMEOUT_MINUTES` (48h); `0` = none where honored; steer never extends it |
| `model` | string | no | Model override |
| `notify_on_complete` | boolean | no | Default true (`BG_NOTIFY_DEFAULT`); `false` = this job stays quiet (result still saved) |

Guards: cannot run from inside a background child (rejected — do the work directly). Only the creating session can read/steer/stop (L1 owner gate, fail-closed not-found).

## background_list()

No params. All jobs with titles, summaries, states. Finished jobs carry `[DONE COMPLETED]` / `[DONE FAILED]` / `[DONE STOPPED]` markers — load-bearing, never rename.

## background_status(id?)

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | no | Job id; omit for all running |

Instant, never blocks. Shows heartbeat age + current step, concurrency (`running/max`), queue depth. `No job <id>` / `No running jobs.` when empty.

## background_read(id)

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | yes | Job id |

Full persisted result (up to 30k chars). `[running]` while active — never blocks. Owner-only (L1). Marks the job read (clears `unread`).

## background_steer(id, instruction)

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | yes | Running **task** job only (bash/queued/finished rejected) |
| `instruction` | string | yes | Follow-up instruction for the child |

Max 5 steers (`MAX_STEERS`); the original deadline is immutable — steer does NOT extend the timeout window.

## background_stop(id)

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | yes | Job id |

Aborts a running job (partial output preserved) or removes a queued job. Already-finished → `already <state>`. Owner-only (L1).

## background_config()

No params. Read-only. Prints the `background-ops v2.2.0-r7-turn-firing` banner, all 8 `BG_` values + env names, and live runtime counts. Changes nothing.
