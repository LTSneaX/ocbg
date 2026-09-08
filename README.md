# ocbg — ours

> Written for the two people who bleed for it: SneaX and Mavis. Not a landing page, not an agent manual. The product record of what runs in production, how we run it, and what it cost us to learn.

## What this is, in one breath

opencode does one thing at a time in the foreground. ocbg is our background: launch a job, keep talking, and get woken with the result when it lands. The agent owns reporting; the plugin owns delivery — five roads (wake note, toast, DONE marker, `.notifications.log`, `app.log`) so no single failure loses a result.

## What's live

- **Version:** `2.2.0-r7-turn-firing` (from the `VERSION` const in `src/plugin/background.ts`, base `920fc3a`)
- **Repo (authority):** `~/projects/ocbg`, `main` only
- **Live (single file):** `~/.config/opencode/plugins/background.ts` — a disk copy of `src/plugin/background.ts`, nothing else
- **Check you're on it:** run `background_config()` in any session — the banner must read `background-ops v2.2.0-r7-turn-firing`. Anything older means the server hasn't rebooted onto this build yet. Stop and reboot before trusting anything.

## How we run it — our cycle

1. **Work repo-first, main-only.** All changes in `~/projects/ocbg`, straight to `main`. No feature branches, no PRs. Live paths receive deployed copies only — never built into, never edited in place.
2. **Gates before commit.** Static first (`tsc --noEmit` green), then the standing rule: no commit until tests are green and the Review Manager pre-commit gate passes. Review happens *before* commit, not after.
3. **Deploy to disk.** Copy the single file live (`cp src/plugin/background.ts ~/.config/opencode/plugins/background.ts`), backup first into `backups/` — never beside the live file.
4. **SneaX boots.** Agents never restart the server, never touch live `plugins/`. Disk deploy + handoff; he reboots.
5. **Banner check.** `background_config()` → `v2.2.0-r7-turn-firing`. No banner, no further steps.
6. **Probes A–D.** Completed (green toasts only), failed (error toasts only), timeout (silent STOPPED), manual stop (STOPPED, partial output kept).
7. **Wake proof.** The parent must take an unprompted turn on completion — auto-read + report. Arrival equals action. That *is* the pass, not a bug.

## Config that matters to us

Set in the environment (e.g. `~/.config/opencode/.env`) **before boot**. The rest are defaults we don't touch — full table in `docs/config.md`.

| Var | Ours | Why |
|---|---|---|
| `BG_IDLE_CLOSE_MS` | `180000` (3m) — **SneaX's number** | Reaper idle window. Raise it if good jobs get reaped; lower it if dead weight lingers. Garbage/NaN/≤0 falls back here. |
| `BG_WAKE_NOTE` | default **ON** | ON = turn-firing reply wake on terminal states (parent ACTS on arrival). `false` = skip the wake call entirely — zero transcript residue; DONE + toast + logs + polling carry on. |
| `BG_NOTIFY_DEFAULT` / `notify_on_complete` | default **true** (noisy) | Per-job `notify_on_complete:false` beats the global for that one job. File + `app.log` fire even when the noisy roads are gated off. |

## What we see per state

SneaX's voice, byte-identical in toast and wake-note lead:

| State | Toast (verbatim) |
|---|---|
| Done | `✓ done, darling: <id> landed clean` |
| Failed | `✗ broke, honey: <id> exit <code> — come look` |
| Timed out | `⏱ too slow, darling: <id> timed out` |
| Stopped | `■ put down: <id> killed on order` |

- **DONE markers are load-bearing.** `[DONE COMPLETED]` / `[DONE FAILED]` / `[DONE STOPPED]` prefix the summary and persisted output. Polling, the banner copy, and the wake text all key off them — never rename, never strip.
- **Wake truth.** r7 fires the wake as reply-mode `promptAsync` *without* `noReply` — arrival triggers a real parent turn (auto-read + report, unprompted). The quiet `noReply` road never acts; that's why r7 replaced it. Chat footprint accepted as the price of arrival-equals-action.
- **Wake = paint.** Any `promptAsync` persists a message row the TUI paints — even empty text, even `noReply`. Only *skipping the call* (`BG_WAKE_NOTE=false`) gives zero residue. That's not a leak, it's the client; the kill-switch is the answer.
- **Always-on logs.** `.notifications.log` (JSON-lines, per-project under `~/.local/share/opencode/background-ops/`) + structured `app.log` event (service `background-ops`) fire on every terminal state, even gated-quiet ones.

## What it cost us — hard-won, don't relearn

- **New shell is not restart.** Plugins load at server boot only. Grep can prove the disk is new while the runtime is still old — believe `background_config()`, not the file. SneaX reboots; then check the banner.
- **Observer-effect polling.** The completion poll writes heartbeats. Called at the top of the reaper loop, it keeps heartbeats forever fresh and neuters the reaper. So the completion sweep sits *after* the heartbeat-staleness gate, never before. Completion still wins via the state re-check.
- **`noReply` never acts.** A quiet wake paints context but takes no turn. Anything that needs the parent to *do* something on arrival needs reply-mode. We built the quiet road, proved it inert, replaced it.
- **DONE prefix load-bearing** (above) — three systems key off it; treat it like a wire protocol.
- **`plugins/` is live-only.** opencode auto-loads *every* `.ts` in there — one backup pileup cost us a full night. Backups go to `backups/` or repo history. Never beside live files.
- **Nested runs are rejected on purpose.** `background_run` inside a background child answers "do the work directly" — that's the fork-bomb guard, not an error. Don't file it, don't route around it.

## Standing decisions

| Decision | In short |
|---|---|
| Main-only, single branch | Straight to `main`, no branches, no PRs. Trunk is always current. |
| SneaX owns boot | Agents never restart the server or touch live `plugins/`. Disk + handoff; he reboots. |
| Owner gate (L1) | `read`/`steer`/`stop` enforce caller === owner, fail-closed not-found. `list`/`status` stay global — cross-session reads *are* the Mavis workflow. |
| Two-signal reaper | A running job dies only when *both* heartbeat *and* child/output prove silence for the idle window (~60s sweep). Any doubt skips to next sweep. |
| `uuid` ids | Default, unguessable. `counter`/`human` are enumerable — demo only, never shared. |
| Steer never extends | `deadlineAt` is immutable, max 5 steers. Past deadline → start a new run. |
| Red stays dead | No terminal-state stderr since r5. File + app.log + wake + toast + DONE carry every state. |

## Rollback — one command

```sh
rm ~/.config/opencode/plugins/background.ts  # then SneaX reboots; verify the tools are gone via background_config()
```

To restore: copy the `backups/` file back over `plugins/background.ts` + reboot. Repo history holds every version — the repo is authority, disk is just a copy.

## The full book

`docs/history.md` — every layer with SHAs, all four wake builds and why r7 won, gates, live-proof recipe, rollback map. Verbatim archive; read it before changing the wake path.

`docs/` map: `internals.md` (lifecycle, reaper, guards) · `api.md` (tool params) · `config.md` (all 8 `BG_` vars) · `troubleshooting.md` (full tree).

## License

MIT. Status: live on `2.2.0-r7-turn-firing`, `origin/main` in sync, SneaX-witnessed Sept 2026.
