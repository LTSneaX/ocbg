# Coverage ratchet — S3a+S3b gate B1 unblock inventory

Base: `a4d78a3` + S3a+S3b uncommitted (S3a queue-pump ×2, S3b v8-ignore backfill).
Suite at inventory time: **146/146 green** (16 files, vitest 5.0.0).
Coverage at inventory time (`npx vitest run --coverage`, v8):
**Lines 100% (626/626)**, Stmts 94.61% (809/855), **Branch 81.98% (528/644 → 116 uncovered)**,
**Funcs 88.33% (106/120 → 14 uncovered)**.

SneaX 100% law: lines 100% holds (proven below); every uncovered branch/function is
named here with a disposition — WAIVER (defensive/host-scream, rationale given) or
TICKET S4-COV-NN (testable, deferred to S4). Nothing unnamed, nothing unticketed.

## A1 — v8-ignore count: 12 lines / 11 regions (correct, no "13" anywhere)

`grep -n "v8 ignore" src/plugin/background.ts` → 12 lines:

| # | Line | Form | Location |
|---|------|------|----------|
| 1 | 352 | next | readLastHeartbeat dead-guard catch |
| 2 | 371 | next | readHeartbeatAgeMs dead-guard catch |
| 3 | 389 | next | readHeartbeatFresh dead-guard catch |
| 4 | 416 | next | taskRefreshSkippable dead-guard catch |
| 5 | 613 | start | allKnownJobsFresh defensive-merge region open |
| 6 | 618 | stop | allKnownJobsFresh defensive-merge region close |
| 7 | 810 | next | completeJobInternal dead-guard catch |
| 8 | 993 | next | refreshTaskJob dead-guard catch |
| 9 | 1030 | next | refreshBashJob dead-guard catch |
| 10 | 1065 | next | taskChildLooksSilent dead-guard catch |
| 11 | 1135 | next | sweepOneJob per-job dead-guard catch |
| 12 | 1162 | next | sweepIdleJobs sweep dead-guard catch |

Regions: 10× `next` + 1× `start/stop` = **11 regions, 12 lines**.
`grep -rn "13.*ignore|ignore.*13|13.*region|13 lines" src/ test/ docs/` → **no hits**:
no S3b doc/comment claims 13; nothing to correct (verified, no edit needed).

## B — Uncovered branches (116, BRDA taken=0 from lcov.info)

Format: ID | src/plugin/background.ts:LINE | code sketch | disposition.
WAIVER = keep uncovered by policy (reason). TICKET S4-COV-NN = testable, S4 work item.

### projectId / warnMalformed / timer helpers (B-001–B-007)
- B-001 :123 `cwd ?? homedir()` nullish-right — WAIVER: homedir fallback only fires when
  factory invoked without directory (host always provides); defensive.
- B-002 :132 `if (root)` early-return — WAIVER: VCS-root fast path, cosmetic hash
  optimization; both paths same value domain.
- B-003 :217 `malformedWarned.has(key)` dedupe-return — WAIVER: log-spam guard,
  unobservable behavior difference.
- B-004 :265 `typeof maybe.unref === "function"` false-arm — WAIVER: host-scream guard
  (non-timer objects); never fires under node.
- B-005 :281 `timer !== null` false-arm — WAIVER: withTimeout always arms; dead by construction.
- B-006 :302 `t !== undefined` false-arm — WAIVER: same, timer always defined here.
- B-007 :304 `p.finally(clearTimeout)` inner clear-guard — WAIVER: fires only on
  abnormal race; timer cleanup best-effort.

### Heartbeat readers (B-008–B-015)
- B-008 :347 `i < 0` no-separator return — TICKET S4-COV-01: malformed-heartbeat unit test.
- B-009/010/011 :349 age-format ternary arms (s/m/h) — TICKET S4-COV-01: minute/hour
  formatting arms never exercised (tests only use seconds-fresh).
- B-012 :368 `Number.isNaN(t)` true-arm — TICKET S4-COV-01: NaN-timestamp heartbeat test.
- B-013 :382 empty-lines early return — TICKET S4-COV-01: empty-heartbeat test.
- B-014 :385 `i < 0` early return — TICKET S4-COV-01: same as B-008 for readHeartbeatFresh.
- B-015 :387 `isNaN(t) ? null` true-arm — TICKET S4-COV-01: same as B-012 for Fresh variant.

### taskRefreshSkippable (B-016–B-019)
- B-016 :404 `timeoutMinutes > 0` true-arm — TICKET S4-COV-02: deadline-skip matrix test.
- B-017 :405 `deadlineAt !== undefined` arm — TICKET S4-COV-02: same matrix.
- B-018 :411 null-heartbeat false-arm — WAIVER: null heartbeat already covered via
  catch path; explicit-null shape unreachable (readers return non-null or throw).
- B-019 :413 clock-skew true-arm — WAIVER: negative-age requires clock skew;
  host-scream guard, untestable deterministically.

### Pool helper (B-020)
- B-020 :443 `typeof fn !== "function"` safeFn fallback — TICKET S4-COV-03: pool
  misuse unit test (non-function fn).

### bashOutputLooksSilent / extractSessionActivityMs (B-021–B-034)
- B-021 :473 non-finite mtime return — WAIVER: stat-failure guard; disk always statable in tests.
- B-022 :475 negative-age return — WAIVER: clock-skew guard (same class as B-019).
- B-023 :484 non-object raw return — WAIVER: API-envelope guard; messages() always
  returns objects in covered paths.
- B-024 :485 `raw.data` object-arm — TICKET S4-COV-04: envelope-shape matrix test.
- B-025/026 :490 `root.messages ?? info.messages ?? null` 2nd/3rd arms —
  TICKET S4-COV-04: same matrix (info-envelope + null-envelope).
- B-027/028/029 :491 bag-shape ternary arms — TICKET S4-COV-04: bag.data-envelope test.
- B-030 :493 `?? {}` fallback — WAIVER: empty-array element guard; msgs non-empty whenever reached.
- B-031/032/033 :499 timestamp-scale arms (ms/s/μs) — TICKET S4-COV-04: numeric-timestamp
  scale matrix (tests only cover ISO strings).
- B-034 :500 string-parse else-arm — WAIVER (covered true-arm only): Date.parse-failure
  → null is host-scream input guard. NOTE: string-success arm IS covered; the zero-taken
  arm is the `typeof s === "string" && s` false-fallthrough combined with NaN sub-arm —
  malformed-string input guard.

### dirMtimeMs / deleteJobTriple (B-035–B-039)
- B-035 :528 non-finite → null — WAIVER: stat-failure guard (same class as B-021).
- B-036 :547 `!safeJobId(id)` return — TICKET S4-COV-05: invalid-id prune test.
- B-037/038/039 :555 prune-conditional arms — TICKET S4-COV-05: live-state prune matrix
  (running/queued retention arms).

### allKnownJobsFresh cache (B-040–B-048)
- B-040 :612 `seen.has` continue-arm — TICKET S4-COV-06: in-memory/disk overlap test.
- B-041 :639 `if (!live) jobs.set` true-arm — partially v8-ignored region (613–618);
  residual arm TICKET S4-COV-06 (same overlap test).
- B-042 :663 `input?.client ?? isClientLike` fallback-arm — WAIVER: factory boot-shape
  debug probe; input always well-formed from loader.
- B-043/044/045 :669 input-shape ternary arms (null/other) — WAIVER: dbg() log-string
  variants; logging only, zero behavior.
- B-046/047/048 :670 client-shape ternary arms — WAIVER: same, log-string variants.

### startTask dispatch (B-049–B-053)
- B-049 :698 `...(job.agent ? ...)` spread arms — TICKET S4-COV-07: agent/modelRef
  dispatch-combination test.
- B-050/051/052 :699 `__bgError` throw arms — TICKET S4-COV-07: promptAsync-failure
  injection test (covered: success path; missing: error-funnel throw + message arms).
- B-053 :702 `e?.message ?? e` fallback-arm — WAIVER: non-Error throw shape;
  host throws Errors in practice.

### pumpQueue / stop/complete guards (B-054–B-061)
- B-054 :741 `jobs.get ?? job` right-arm — TICKET S4-COV-08: stale-ref race test
  (job evicted from map before close handler).
- B-055 :754 `timeoutMinutes > 0` false-arm — TICKET S4-COV-08: no-timeout queued-job
  pump test.
- B-056 :767 `jobs.get ?? job` right-arm — TICKET S4-COV-08: same race class (stop path).
- B-057 :768 early-return true-arm — TICKET S4-COV-08: stop-nonrunning test.
- B-058/059 :771 post-abort recheck arms — TICKET S4-COV-08: abort-race test
  (completion lands during abort).
- B-060 :797 `jobs.get ?? job` right-arm — TICKET S4-COV-08: same race class (complete path).
- B-061 :798 early-return true-arm — TICKET S4-COV-08: complete-nonrunning test.

### notifyJob (B-062–B-069)
- B-062 :841 `jobs.get ?? job` right-arm — TICKET S4-COV-09: notify stale-ref test.
- B-063 :842 mid-run early-return true-arm — TICKET S4-COV-09: notify-running guard test.
- B-064 :848 `endedAt ?? now` fallback-arm — WAIVER: endedAt always set on terminal
  transition before notify; dead by ordering.
- B-065 :853 same `??` — WAIVER: same as B-064.
- B-066 :854 `timeoutMinutes > 0` false-arm — TICKET S4-COV-09: no-timeout elapsed test.
- B-067 :866 `live._cwd ?? safeDirectory` right-arm — WAIVER: _cwd always stamped at
  creation; host-scream fallback.
- B-068/069 :927 notify-catch `?.` arms — WAIVER: catch-block stringification arms;
  error path itself is best-effort host-scream (console.error only).

### refreshTaskJob poll/timeout (B-070–B-081)
- B-070 :937 `jobs.get ?? job` right-arm — TICKET S4-COV-10: refresh stale-ref test.
- B-071 :948 skip-gate true-arm — WAIVER: skip path covered at unit level
  (taskRefreshSkippable tests); integration arm needs time-travel, S4 nice-to-have →
  TICKET S4-COV-10 (fresh-heartbeat skip integration).
- B-072 :953 `?.data ?? msgs` right-arm — TICKET S4-COV-10: unwrapped-envelope poll test.
- B-073 :954 non-array `messages` arm — TICKET S4-COV-10: same envelope matrix.
- B-074 :962 `m.info.parts` fallback-arm — TICKET S4-COV-10: info-envelope parts test.
- B-075 :964 non-text-part arm — TICKET S4-COV-10: mixed-parts poll test.
- B-076 :967 `|| "(no text output)"` right-arm — TICKET S4-COV-10: empty-text poll test.
- B-077 :976 poll-exception heartbeat arm — WAIVER: fires only inside the
  best-effort poll catch; host-scream path (poll throws = API down).
- B-078 :977 poll-exception complete arm — WAIVER: same catch block, same reason.
- B-079/080 :983 state/timeout conditional arms — TICKET S4-COV-10: legacy-timeout
  enforcement test (no-deadlineAt jobs).
- B-081 :984 `deadlineAt !== undefined` legacy-arm — TICKET S4-COV-10: same test.

### refreshBashJob (B-082–B-089)
- B-082 :1004 `jobs.get ?? job` right-arm — TICKET S4-COV-11: bash stale-ref test.
- B-083 :1005 kind/state guard true-arm — TICKET S4-COV-11: refresh-nonbash test.
- B-084/085 :1009 post-close recheck arms — TICKET S4-COV-11: bash close-race test.
- B-086 :1011 non-zero exit arm — TICKET S4-COV-11: bash-fail (non-zero exit) test.
- B-087/088 :1019 timeout-gate arms — TICKET S4-COV-11: bash-timeout enforcement test.
- B-089 :1021 legacy-deadline arm — TICKET S4-COV-11: same test (legacy jobs).

### taskChildLooksSilent lookups (B-090–B-098)
- B-090 :1042 no-childSessionID return — WAIVER: reaper only probes task jobs with
  children; guard dead by caller contract.
- B-091 :1044 no-api return — WAIVER: host-scream guard (client without session surface).
- B-092/093/094/095 :1046–1049 lookup-shape push arms — TICKET S4-COV-12: per-shape
  lookup tests (get/info/messages/listMessages absent-arm each).
- B-096 :1050 empty-lookups return — WAIVER: fully-unknown API shape; host always
  exposes ≥1 lookup (host-scream guard).
- B-097 :1058 `!raw` return — WAIVER: all-lookups-null guard; needs total API outage.
- B-098 :1062 clock-skew return — WAIVER: negative-age guard (same class as B-019).

### sweepOneJob (B-099–B-101)
- B-099 :1101 completion-won return — TICKET S4-COV-13: sweep-vs-complete race test.
- B-100 :1113 `jobs.get ?? job` right-arm — TICKET S4-COV-13: sweep stale-ref test.
- B-101 :1114 non-running return — TICKET S4-COV-13: sweep-nonrunning test.

### Tool-surface / events (B-102–B-116)
- B-102 :1222 `timeout > 0` false-arm — TICKET S4-COV-14: no-timeout background_run test.
- B-103 :1245 `ctx.directory || safeDirectory` right-arm — WAIVER: directory always
  provided by host; fallback dead in practice.
- B-104 :1260 same — WAIVER: same as B-103 (status path).
- B-105 :1266 elapsed `?? now` arm — WAIVER: same class as B-064 (endedAt ordering).
- B-106 :1275 `jobs.get ?? loadJob` right-arm — TICKET S4-COV-14: read-evicted-job
  (disk-fallback) test.
- B-107 :1292 same — TICKET S4-COV-14: steer disk-fallback test.
- B-108 :1298 `steerCount ?? 0` right-arm — WAIVER: legacy jobs without counter;
  all created jobs stamp 0. Covered left-arm only.
- B-109/110 :1300 steer-catch throw/skip arms — WAIVER: steer-failure funnel;
  needs promptAsync rejection injection → TICKET S4-COV-14 (steer-failure test).
  Disposition: TICKET S4-COV-14.
- B-111 :1309 same as B-106 (stop path) — TICKET S4-COV-14: stop-evicted-job test.
- B-112 :1314 `idx >= 0` false-arm — WAIVER: queue-membership race; removal only
  offered for queued jobs (dead by UI contract).
- B-113 :1357 non-idle-event null-arm — TICKET S4-COV-15: non-idle event test.
- B-114 :1365 `continue` true-arm — TICKET S4-COV-15: idle-event non-matching-job test.
- B-115 :1380 `|| j.unread` filter arm — WAIVER: compact-hook filter; unread-only jobs
  exist only transiently — TICKET S4-COV-15 (compact-hook unread test).
  Disposition: TICKET S4-COV-15.
- B-116 :1381 `if (active.length)` false-arm — TICKET S4-COV-15: compact-hook empty test.

Ticket rollup: S4-COV-01 (heartbeat malformed/format matrix) · S4-COV-02 (deadline-skip
matrix) · S4-COV-03 (pool misuse) · S4-COV-04 (activity-envelope matrix) ·
S4-COV-05 (prune matrix) · S4-COV-06 (cache-overlap) · S4-COV-07 (dispatch error funnel) ·
S4-COV-08 (task stop/complete races) · S4-COV-09 (notify guards) · S4-COV-10 (task
poll/timeout matrix) · S4-COV-11 (bash refresh matrix) · S4-COV-12 (lookup shapes) ·
S4-COV-13 (sweep races) · S4-COV-14 (tool-surface fallbacks) · S4-COV-15 (event/compact).
Waivers: all rationale-tagged defensive/host-scream/log-only/dead-by-construction.

---

# S4b backfill inventory (2026-09-12, S4a tree: HEAD 32136b7 + untracked test/s4-lifecycle.test.ts + test/s4-reaper.test.ts)

Suite at inventory time: **219/219 green** (18 files, vitest 5.0.0; S4a added 73 its:
56 lifecycle + 17 reaper).
Coverage at inventory time (`npx vitest run --coverage`, v8):
**Lines 100% (626/626)** — S4b line gate HOLDS, zero uncovered lines, no backfill
tests required for lines. Stmts 98.01% (838/855 → 17 uncovered, every one shares
its line with a covered statement, hence lines stay 100%). **Branch 91.61%
(590/644 → 54 uncovered, down from 116 at S3b)**. **Funcs 98.33% (118/120 → 2
uncovered, down from 14 at S3b)**.

S4a progress vs S3b: S4-COV-01/02/03/04/05/09/10(partial)/12/15 CLOSED at branch
level (heartbeat matrix, deadline-skip, pool misuse, envelope matrix, prune matrix,
notify guards, lookup shapes, event/compact — zero residual uncovered branches).
S4-COV-06/07/08/10(residual)/11/13/14 remain OPEN (see below). No production logic
touched by S4b; this section is docs-only.

## S4b — Uncovered branches (54, `npx vitest run --coverage --coverage.reporter=json`)

Carry-forward S3b IDs where the code is unchanged (line numbers re-verified on the
1386-line tree); every item keeps its S3b disposition unless noted.

WAIVER (defensive/host-scream/log-only/dead-by-construction, keep uncovered):
- :123 binary-expr (B-001), :132 if (B-002), :265/:281/:302/:304 timer guards
  (B-004–B-007), :473 (B-021 stat-failure), :493 `?? {}` (B-030), :528 (B-035
  stat-failure), :639-adjacent dbg ternaries :663/:669×3/:670×3 (B-042–B-048,
  log-strings), :848/:853 (B-064/065 dead-by-ordering), :927×2 (B-068/069
  catch-stringify), :1042/:1044/:1058/:1062 (B-090/091/097/098 silence-guard
  fail-closed arms — covering them would mean PROVING a reap, inverted incentive),
  :1245/:1260 (B-103/104 host directory), :1266 (B-105 endedAt ordering).
- S4b-NEW-01 :586 `catch { return pruned; }` (pruneOldJobs readdirSync funnel) —
  WAIVER: fires only if the job dir becomes unreadable between baseDir-mkdir and
  readdir (disk failure / revoked perms mid-sweep); host-scream, needs fault
  injection between two adjacent syscalls, untestable deterministically.
- S4b-NEW-02 :177 `catch { return; }` (hardenPerms readdirSync funnel) — WAIVER:
  same class as S4b-NEW-01 (mkdir just succeeded, readdir fails = disk yanked);
  host-scream, best-effort posture is the documented contract.
- S4b-NEW-03 :60 `catch { return false; }` (bgDebugEnabled env-access funnel) —
  WAIVER: process.env property access throws only under a hostile loader membrane;
  host-scream guard, one-line total function.

TICKET (testable, deferred — S4-COV series stays open, S5+ may claim):
- S4-COV-06 (cache-overlap): :612 `seen.has` continue, :639 `if (!live)` — needs
  in-memory/disk overlap double-boot test.
- S4-COV-07 (dispatch error funnel): :699 `__bgError` arm — needs promptAsync
  rejection injection.
- S4-COV-08 (stop/complete races): :741/:768/:797 `jobs.get ?? job` right-arms,
  :754 `timeoutMinutes > 0` false-arm, :771 post-abort recheck — needs stale-ref /
  abort-race fault injection.
- S4-COV-10 (task poll/timeout residual): :937 stale-ref, :948 skip-gate true-arm
  (fresh-heartbeat skip integration needs time-travel), :983 legacy-timeout arms.
- S4-COV-11 (bash refresh matrix): :1004 stale-ref, :1005 kind/state guard,
  :1009 close-race, :1011 non-zero-exit arm, :1019/:1021 timeout/legacy arms.
- S4-COV-13 (sweep races): :1101 completion-won, :1113 stale-ref, :1114
  non-running return — needs sweep-vs-complete race orchestration.
- S4-COV-14 (tool-surface fallbacks): :1222 no-timeout run, :1275/:1292/:1309
  read/steer/stop disk-fallback (evicted-job) arms.

## S4b — Uncovered functions (2)

- FN:606 allKnownJobsFresh `catch { return out.sort(...) }` baseDir-throw funnel
  (F-002) — WAIVER: baseDir throws only on unresolvable cwd (host-scream).
- FN:1175 setInterval tick `() => { sweepIdleJobs().catch(...) }` (F-012) —
  WAIVER: timer callback never fires under the fake-timer-less suite; armed-once
  covered, tick is live-only.

## S4b — Uncovered statements (17, all line-shared → lines 100% unaffected)

:60 (S4b-NEW-03) · :132 (B-002) · :177 (S4b-NEW-02) · :473 (B-021) · :586
(S4b-NEW-01) · :606×2 (F-002) · :768 (B-057) · :771 (B-058/059) · :798 (B-061) ·
:948 (B-071) · :1005 (B-083) · :1042/:1044/:1058/:1062 (B-090/091/097/098) ·
:1114 (B-101). Each shares its line with a covered statement/branch arm; no
line-level action. No v8-ignore added (12 lines / 11 regions unchanged).

## S4b re-proof (post-docs, production code untouched)

- `npm test` → 219/219 green (18 files).
- `npx vitest run --coverage` → Lines 100% (626/626); Branch 91.61% (54 named
  above); Funcs 98.33% (2 named above); Stmts 98.01% (17 named above).
- `tsc --noEmit` → exit 0. `scripts/loader-guard.sh` → green (probe-3
  manifest-acceptance incl). `node --check` → all 21 dist .js OK.
  `test/boot-contract.test.ts` solo → 5/5.
- Change set: docs/coverage-ratchet.md (this S4b section) ONLY, uncommitted.

## F — Uncovered functions (14, FNDA=0 from lcov.info)

All in src/plugin/background.ts. Anonymous v8 labels resolved to enclosing expressions:

- F-001 FN:443 pool `async () => {}` safeFn fallback — TICKET S4-COV-03 (with B-020).
- F-002 FN:606 allKnownJobsFresh `catch { return out.sort(...) }` baseDir-throw funnel —
  WAIVER: baseDir throws only on unresolvable cwd (host-scream); mkdir-failure path.
- F-003 FN:698 promptAsync `.catch(e => ({__bgError: e}))` mapper — TICKET S4-COV-07.
- F-004 FN:769 session.abort `.catch(() => null)` (stop path) — WAIVER: abort-failure
  best-effort; covered behaviorally (abort success), rejection arm needs fault injection.
- F-005 FN:875 app.log `.catch(() => null)` (notify path) — WAIVER: observability
  best-effort, host-scream.
- F-006 FN:900 wake-note promptAsync `?.catch(() => null)` — WAIVER: parent-gone
  best-effort, host-scream.
- F-007 FN:906 showToast `?.catch(() => null)` — WAIVER: headless-TUI best-effort.
- F-008 FN:951 session.messages `?.catch(() => null)` (poll) — WAIVER: API-down
  best-effort; rejection arm = host-scream.
- F-009 FN:986 session.abort `?.catch(() => null)` (timeout path) — WAIVER: same as F-004.
- F-010 FN:1049 listMessages lookup arrow — TICKET S4-COV-12 (shape absent in test double).
- F-011 FN:1132 sweep app.log `?.catch(() => null)` — WAIVER: observability best-effort.
- F-012 FN:1175 setInterval tick `() => { sweepIdleJobs().catch(...) }` — WAIVER: timer
  callback never fires under fake-timer-less suite; armed-once covered, tick live-only.
- F-013 FN:1300 steer promptAsync `.catch(e => { throw ... })` mapper —
  TICKET S4-COV-14 (with B-109/110).
- F-014 FN:1381 compact-hook `.map(...)` inner arrow —   TICKET S4-COV-15 (fires only when active.length > 0 with running jobs at compact time).

## Re-proof (post-docs, production code untouched)

- `npm test` → 146/146 green (see TMP logs below).
- `npx vitest run --coverage` → Lines 100% (626/626); Branch 81.98% (116 named above);
  Funcs 88.33% (14 named above).
- `tsc --noEmit` → exit 0. `scripts/loader-guard.sh` → green. `node --check` on
  dist/plugin/background.js → OK.
- Change set: docs/coverage-ratchet.md (this file) ONLY, uncommitted. No production
  logic touched; no v8-ignore added/removed (12 lines / 11 regions unchanged).

---

# S5 wake-voice inventory (2026-09-12, S5 tree: HEAD 77ccf56 + uncommitted S5 delta)

S5 is the first slice that touches production wake/compact code since the
zero-rebuild: the turn-firing wake funnel (promptAsync WITHOUT noReply,
terminal-only, mid-run no-op, BG_WAKE_NOTE kill-switch, single-writer notified
guard, DONE-marker, capped .notifications.log) was already byte-complete from
the r7 carry-forward and already covered by the G1 notify-matrix suite, so the
S5 production delta is exactly ONE hook: `experimental.session.compacting`
expanded from the one-line ids shape to the U5 rich shape (running[] ALL live
ids + unread capped at the 10 oldest with a `(+N more)` overflow note +
`background_read(id)` read-hint; single push keeps the pre-S5 length-1
contract; empty stays silent; best-effort, never throws).

Suite at inventory time: **227/227 green** (19 files, vitest 5.0.0; S5 adds 8
its in test/s5-wake-voice.test.ts).
Coverage at inventory time (`npx vitest run --coverage`, v8):
**Lines 100% (632/632)** — S5 line gate HOLDS (+6 lines vs S4b, every one in
the new compact hook, every one executed). Stmts 98.02% (843/860). **Branch
91.64% (592/646)**. **Funcs 98.31% (117/119)** — net −1 function identity vs
S4b (old hook: 5 arrows; new hook: 4 arrows), zero new uncovered functions
(the 2 uncovered are the standing F-002/F-012 waivers, unchanged). No v8-ignore
added/removed (12 lines / 11 regions unchanged).

## S5 — New branches (4 arms, ALL COVERED, no waivers needed)

Line numbers on the 1397-line S5 tree (src/plugin/background.ts):

- S5-B-01 :1387 `!running.length && !unread.length` true-arm — COVERED:
  pre-existing empty-compact tests (s4-lifecycle "stays quiet when empty").
- S5-B-02 :1387 same-condition false-arm — COVERED: every non-empty compact
  call (pre-existing running/unread tests + 2 new S5 compact tests).
- S5-B-03 :1392 `overflow > 0` true-arm — COVERED: new S5 cap test (11 unread
  bash jobs → `(+1 more)`, exactly 10 `[completed]` markers, oldest shown,
  newest held back).
- S5-B-04 :1392 `overflow > 0` false-arm — COVERED: new S5 rich-shape test
  (1 running + 1 unread → no overflow note, `running=[id]`,
  `<id> [completed]`, `background_read(` hint present).

## S5 — New tests (test/s5-wake-voice.test.ts, 8 its)

Wake-matrix throw/timeout-fallback arm (G1 covers ON/OFF × terminal/mid-run;
S5 pins the fault arm + the reply-mode bytes):

1. reply-mode contract: wake fires WITHOUT `noReply`, `[background-ops]`
   trusted prefix, `Untrusted child output` fence, `background_read("<id>")`
   read-hint.
2. wake promptAsync sync-throw → terminal still lands, notified, DONE/toast/
   app.log/.notifications.log all present (throw fallback).
3. wake promptAsync rejection → same (rejection fallback, wake attempted once).
4. wake surface missing (`promptAsync = undefined`) → fully silent wake, DONE/
   toast/logs carry it (headless-parent fallback).
5. toast rejection → DONE + notified still land (headless-TUI fallback).
6. DONE-marker EISDIR fallback: planted RUNNING bash job with outputPath = a
   directory → background_stop stays total (stopped + notified + `[DONE
   STOPPED]` + exactly one wake + toast). Covers the stop-path read catch
   (:774) and the notify-path read catch (:923) deterministically.
7. compacting rich shape (see S5-B-04).
8. compacting unread cap (see S5-B-03).

Test-behavior note (pin for future slices): `background_read` clears `unread`,
so compact-hook tests MUST poll the state file (`readState` loop), never
`waitTerminal`/`background_read`, or the unread set evaporates before the
hook runs (found red, fixed green in-S5).

## S5 — Ticket impact

- S4-COV-15 (event/compact) stays CLOSED: its residual compact arms are
  covered, and the 4 new S5 compact arms are covered above.
- S4-COV-06/07/08/10(residual)/11/13/14 remain OPEN, untouched by S5 (no
  production lines in their areas changed).
- Waivers carried forward unchanged (S4b-NEW-01/02/03, B-001–B-007, B-018/019,
  B-021, B-030, B-035, B-042–B-048, B-064/065, B-068/069, B-090/091/097/098,
  B-103/104/105, F-002, F-012).

## S5 re-proof (post-docs check-list for the pre-commit gate)

- `npm test` → 227/227 green (19 files).
- `npx vitest run --coverage` → Lines 100% (632/632); Branch 91.64% (new arms
  S5-B-01–04 all covered); Funcs 98.31% (uncovered = standing F-002/F-012).
- `tsc --noEmit` → exit 0. `scripts/loader-guard.sh` → green (probe-3
  manifest-acceptance incl). `node --check` → all dist .js OK.
  `test/boot-contract.test.ts` solo → 5/5.
- Change set: src/plugin/background.ts (compact hook ONLY, +11/−1 lines) +
  test/s5-wake-voice.test.ts (NEW, 8 its) + docs/coverage-ratchet.md (this S5
  section), ALL uncommitted. No live writes, no repo logs/ (logs in
  /tmp/ocbg-logs/).

---

# S6 hardening inventory (2026-09-12, S6 tree: HEAD 060c2ae + uncommitted S6 delta)

S6 is hardening-only: four same-line production edits, zero new lines, zero
new branch arms. The suite grows by 6 its (new test/s6-hardening.test.ts) and
one contract update (deadline-steer substring test → state-only expectation).

Suite at inventory time: **233/233 green** (20 files, vitest 5.0.0; S6 adds 6:
steer-wording pin, title-creation fence, list-render fence, legacy-title
fence, hostile-completion M1 fence, stop-past-deadline secondary arm).
Coverage at inventory time (`npx vitest run --coverage`, v8):
**Lines 100% (632/632)** — S6 line gate HOLDS (+0 lines: every edit is
same-line). Stmts 98.02% (843/860, unchanged). **Branch 91.61% (590/644)** —
numerator AND denominator each −2 vs S5 (592/646): the removed tertiary
`/timeout/i` disjunct drops its two arms (both previously covered by the old
substring test), so the percentage is byte-identical and no coverage is lost.
**Funcs 98.31% (117/119)** — unchanged (standing F-002/F-012 waivers). No
v8-ignore added/removed (12 lines / 11 regions unchanged). The "Uncovered
Line #s" column again lists partial-branch lines only (same class as S4b/S5);
lines 632/632 = zero uncovered lines.

## S6 — Production deltas (src/plugin/background.ts, all branch-free)

- S6-D-01 cleanSingleLine backticks (:78): adds `.replace(/`/g, "")` to the
  existing chained-replace pipeline + comment mentions ``` markdown-fence
  breakout. String.replace with a regex (no callback) adds no branch arms.
- S6-D-02 title creation fence (:1223): `title:` wrapped in
  `cleanSingleLine(...)` (pure call, no new arms). Stored titles are now
  single-line ≤120 chars with no `"`/backticks going forward.
- S6-D-03 list render title fence (:1250): `${j.title}` → 
  `${cleanSingleLine(j.title)}` (pure call, no new arms). Covers legacy
  on-disk titles predating S6-D-02.
- S6-D-04 isTimeout state-only (:849-855): removes the tertiary
  `(live.timedOut === undefined && /timeout/i.test(live.summary))` disjunct +
  comment rewrite (tertiary → gone). Timeout labels now derive from the
  timedOut flag (primary) or stopped-at/past-deadline (secondary) only —
  untrusted summary text can no longer vote on the event label. Removes 2
  covered branch arms (see counts above).
- Steer wording: already `deadline NOT extended` (:1289 description, :1302
  return) — S6 pins it with a test, zero code change.

## S6 — New/updated tests

- test/s6-hardening.test.ts (NEW, 6 its): steer description wording pin
  (contains `deadline NOT extended`, no `extends timeout window`); hostile
  prompt → stored title single-line, no quotes/backticks, `task:` prefix,
  ≤120 chars; hostile title → list keeps one line per job, head clean;
  planted legacy title with separators → list renders single-line; hostile
  task completion (newlines + quotes + ``` + `"""` + injection text) →
  wake-note inner block and DONE summary carry no `"`/backtick/newline;
  stop-past-deadline with no flag → event `timeout` (secondary arm).
- test/deadline-steer.test.ts (UPDATED, 1 it): the old `substring fallback`
  test is rewritten as `S6 state-only` — same setup (steer mentioning
  "timeout", then manual stop), now expects event `stopped`. This is the S6
  contract change, not a coverage loss: the removed arms leave the tree.
- Test-behavior note (extends the S5 pin): task completion in tests needs the
  `background_list` pre-render refresh before `waitTerminal`; `background_read`
  alone never polls. And wake-note assertions must scope to the INNER
  untrusted block — the trusted `"""` delimiters are framing, not payload.

## S6 — Ticket impact

- S4-COV-06/07/08/10(residual)/11/13/14 remain OPEN, untouched by S6 (no
  production lines in their areas changed).
- S4-COV-15 stays CLOSED. No new tickets, zero new waivers.
- Waivers carried forward unchanged (S4b-NEW-01/02/03, B-001–B-007,
  B-018/019, B-021, B-030, B-035, B-042–B-048, B-064/065, B-068/069,
  B-090/091/097/098, B-103/104/105, F-002, F-012).

## S6 re-proof (post-docs check-list for the pre-commit gate)

- `npm test` → 233/233 green (20 files).
- `npx vitest run --coverage` → Lines 100% (632/632); Branch 91.61%
  (delta −2/−2 from the removed tertiary arms, % unchanged); Funcs 98.31%
  (uncovered = standing F-002/F-012).
- `tsc --noEmit` → exit 0. `scripts/loader-guard.sh` → green (probe-3
  manifest-acceptance incl). `node --check` → all dist .js OK.
  `test/boot-contract.test.ts` solo → 5/5.
- Change set: src/plugin/background.ts (4 same-line hardening edits) +
  test/s6-hardening.test.ts (NEW, 6 its) + test/deadline-steer.test.ts
  (1 contract update) + .gitignore (tmp/log hygiene append) + README.md
  (+2 Development bullets, 203→205 lines, same headings/order) +
  docs/coverage-ratchet.md (this S6 section), ALL uncommitted. No live
  writes, no repo logs/ (logs in /tmp/ocbg-logs/).
