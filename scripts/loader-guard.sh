#!/bin/sh
# ocbg loader-contract guard — opencode loads a plugin file only when every
# module-namespace export is a function (or an erased type). A single exported
# number/string/object kills ALL 7 tools at boot with
# "failed to load plugin ... Plugin export is not a function".
#
# This probe builds (tsc emit → dist/src/plugin/background.js) and fails red
# (exit 1, names the tripwire) unless every runtime export is a function.
# Single source of truth: called by scripts/pre-push.sh and .github/workflows/ci.yml.
#
# Second probe (invoke-robustness): the loader may invoke every export as a
# factory with boot-like shapes. Calls each function export with {} and
# undefined and fails red (exit 1, names the thrower) on ANY throw — a throw
# here kills the whole boot (runBoundedPool({client…}) `items is not iterable`
# at :312; factory destructure on undefined; debouncer flush/timer with
# garbage fn). Debouncer-shaped results get schedule/cancel/flush exercised
# too (flush threw sync on old bytes; the armed timer crashed the process).

set -eu

cd "$(dirname "$0")/.."

echo "[loader-guard] building (tsc emit) for probe..."
npx tsc

echo "[loader-guard] probing module-namespace exports..."
node --input-type=module -e "import('./dist/src/plugin/background.js').then(m => { let bad = 0; for (const [k, v] of Object.entries(m)) { if (typeof v !== 'function') { console.error('LOADER-TRIPWIRE ' + k + ' ' + typeof v); bad = 1; } } if (!bad) console.log('LOADER-GUARD green: all exports are functions'); process.exit(bad); })"

echo "[loader-guard] probing invoke-robustness (loader-style {} / undefined on every export)..."
PROBE_HOME="$(mktemp -d)"
export HOME="$PROBE_HOME"
trap 'rm -rf "$PROBE_HOME"' EXIT
unset BG_DEBUG
node --input-type=module -e '
import("./dist/src/plugin/background.js").then(async (m) => {
  let bad = 0;
  const fail = (name, via, e) => { console.error("INVOKE-THROW " + name + " via " + via + ": " + ((e && e.message) || e)); bad = 1; };
  process.on("uncaughtException", (e) => { console.error("INVOKE-THROW uncaughtException: " + ((e && e.message) || e)); process.exit(1); });
  const fns = Object.entries(m).filter((kv) => typeof kv[1] === "function");
  if (fns.length === 0) { console.error("INVOKE-THROW <no function exports found>"); process.exit(1); }
  const debouncers = [];
  for (const pair of fns) {
    const k = pair[0], fn = pair[1];
    for (const shape of ["{}", "undefined"]) {
      try {
        const r = await fn(shape === "undefined" ? undefined : {});
        if (r && typeof r.schedule === "function" && typeof r.cancel === "function" && typeof r.flush === "function") debouncers.push([k + "/" + shape, r]);
      } catch (e) { fail(k, shape, e); }
    }
  }
  for (const pair of debouncers) {
    const name = pair[0], d = pair[1];
    try {
      d.schedule();
      await new Promise((r) => setTimeout(r, 150));
      d.flush();
      d.schedule();
      d.cancel();
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) { fail(name, "schedule/flush/cancel", e); }
  }
  await new Promise((r) => setTimeout(r, 150));
  if (bad) process.exit(1);
  console.log("INVOKE-GUARD green: " + fns.length + " exports unthrowable on {}/undefined + " + debouncers.length + " debouncer(s) exercised");
  process.exit(0);
}).catch((e) => { console.error("INVOKE-GUARD import failed: " + ((e && e.message) || e)); process.exit(1); });
'
echo "[loader-guard] invoke-robustness green"
