# ocbg config — the 8 `BG_` variables

> Set in the environment (e.g. `~/.config/opencode/.env`) **before server boot**. Defaults are right for almost everyone — the "When" column says when to touch. Source of truth: `CONFIG` in `src/plugin/background.ts`.

| Var | Type | Default | When to touch |
|-----|------|---------|---------------|
| `BG_MAX_TIMEOUT_MINUTES` | number | `2880` (48h) | A job legitimately needs >48h (rare) |
| `BG_MAX_CONCURRENT_JOBS` | number | `10` | You routinely run >10 and the machine can take it |
| `BG_JOB_ID_TYPE` | `uuid`\|`counter`\|`human` | `uuid` | Demo only — `counter`/`human` ids are guessable, never in shared projects |
| `BG_MAX_BASH_BYTES` | number | `4096` | Commands keep getting rejected *and* splitting truly doesn't work |
| `BG_LIST_CACHE_TTL_MS` | number | `5000` | Never — legacy knob, kept for compat |
| `BG_NOTIFY_DEFAULT` | boolean | `true` | You want new jobs quiet by default (results still saved) |
| `BG_IDLE_CLOSE_MS` | ms | `180000` (3m) | Good jobs reaped (raise) or dead jobs linger (lower); garbage/≤0 falls back to 3m |
| `BG_WAKE_NOTE` | boolean | `true` (ON) | `false` = zero transcript wake, poll via list/toast/logs instead |

The two that matter, commented:

```sh
# Reaper idle window (SneaX's number): a job dies only when BOTH heartbeat
# AND child/output go silent for this long. Raise if good jobs get reaped.
BG_IDLE_CLOSE_MS=180000

# Transcript wake: ON = parent takes an unprompted turn on finish (arrival =
# action). false = skip the wake entirely (zero residue); DONE + toast +
# .notifications.log + app.log keep working, so nothing is lost.
BG_WAKE_NOTE=true
```

Precedence: per-job `notify_on_complete:false` beats `BG_NOTIFY_DEFAULT=true` for that job; `BG_NOTIFY_DEFAULT=false` quiets new jobs by default; `BG_WAKE_NOTE=false` kills only the wake message — popups, DONE markers, both logs keep firing.
