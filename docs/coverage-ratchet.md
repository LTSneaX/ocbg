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
