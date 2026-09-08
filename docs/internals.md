# ocbg internals — lifecycle, reaper, guards, gates

> Detail offloaded from the README. Source of truth is `src/plugin/background.ts`; full saga lives in `docs/history.md` (H4–H8).

## Lifecycle

1. `background_run` creates the job (`running`, or `queued` past 10 slots) and returns the id immediately.
2. Task jobs run in a child session; bash jobs spawn a shell writing to `<id>.md` (+ `<id>.json` state) under `~/.local/share/opencode/background-ops/`.
3. Completion sweep refreshes running jobs (task/bash) and detects terminal states.
4. First terminal transition wins (`notified` set before the first await) → notify funnel: file + `app.log` always, then wake + toast + DONE if `shouldNotify` allows.
5. Parent wakes (turn-firing reply, arrival = action), auto-reads, and reports in its own words. Results persist on disk — they survive restarts and compaction.

Restart: plugins load at server boot only; jobs are re-read from disk (`*.json`/`*.md`), so nothing is lost. Queue wait doesn't burn budget — `deadlineAt` is re-anchored once at queue-start, then immutable.

## Reaper (two-signal, 180s / 60s)

A running job is closed as stale only when **both** prove silence for ≥ `BG_IDLE_CLOSE_MS` (default 180000ms = 3m) on a ~60s sweep (`IDLE_SWEEP_INTERVAL_MS = 60_000`): (1) stale heartbeat (missing/unparseable → skip; clock-skew negative → fresh), (2) stale child/output (task: `taskChildLooksSilent`, any doubt → skip; bash: output mtime). Doubt always skips; retry next sweep. Reaped closes are routine silent closes (`app.log` info + heartbeat trail, never red).

## Guards

- **M1** — untrusted fence + single-line cap (120 chars) on every auto-injection path (wake note, DONE, list).
- **R1** — same fence on the manual paths (`list`/`status`/running-`read`); the global list stays global by design.
- **L1** — owner gate, fail-closed: only the creating session can read/steer/stop (foreign ids get not-found replies). `list`/`status` stay global — cross-session reads are the workflow.
- **L2** — `deadlineAt` immutable (steer never extends it), `MAX_STEERS = 5`, state-derived timeout label.
- **L3** — dirs `0o700`, files `0o600`, `hardenPerms` on boot (best-effort, never throws).

## Gates

| Gate | Verdict |
|------|---------|
| r6 + voice `3a45a6f67` | APPROVED_WITH_CONDITIONS — 0C/0H/1M/3L |
| hardening `047e9287` | APPROVED_WITH_CONDITIONS — 0C/0H/0M/2L (M1 + L1/L2/L3 closed) |
| r6c `e4009d3` | No re-gate (OFF shrinks envelope, ON byte-identical) |
| r7 `4ad4612` | Self-gated: `tsc --noEmit` 0, 7/7 tools, guards inventoried |

Any future diff re-adding loud terminal stderr, full-body injection, new egress/ports/secrets, or a `noReply`-less change to the idle path re-opens the gate.
