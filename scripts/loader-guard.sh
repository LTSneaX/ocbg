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
# here kills the whole boot (r8 strip: exactly BackgroundOps+default, both
# factories; the factory destructure on undefined used to kill the boot,
# fixed 5bf948f). No helper exports remain, so no debouncer/pool arms.

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
  for (const pair of fns) {
    const k = pair[0], fn = pair[1];
    for (const shape of ["{}", "undefined"]) {
      try {
        await fn(shape === "undefined" ? undefined : {});
      } catch (e) { fail(k, shape, e); }
    }
  }
  await new Promise((r) => setTimeout(r, 150));
  if (bad) process.exit(1);
  console.log("INVOKE-GUARD green: " + fns.length + " exports unthrowable on {}/undefined (r8: exactly BackgroundOps+default)");
  process.exit(0);
}).catch((e) => { console.error("INVOKE-GUARD import failed: " + ((e && e.message) || e)); process.exit(1); });
'
echo "[loader-guard] invoke-robustness green"

echo "[loader-guard] probing manifest-acceptance (exactly BackgroundOps+default, zero helper exports)..."
node --input-type=module -e '
import("./dist/src/plugin/background.js").then(async (m) => {
  const plugin = ["BackgroundOps", "default"];
  const helpers = []; // r8 strip: every helper is module-private — nothing beyond 1+default may ship
  const allow = [...plugin, ...helpers].sort();
  const keys = Object.keys(m).sort();
  const same = keys.length === allow.length && keys.every((k, i) => k === allow[i]);
  if (!same) { console.error("MANIFEST-MISMATCH got=[" + keys.join(",") + "] want=[" + allow.join(",") + "]"); process.exit(1); }
  for (const k of plugin) {
    if (typeof m[k] !== "function") { console.error("MANIFEST-TRIPWIRE plugin entry " + k + " is " + typeof m[k]); process.exit(1); }
  }
  for (const k of helpers) {
    if (typeof m[k] !== "function") { console.error("MANIFEST-TRIPWIRE helper " + k + " is " + typeof m[k]); process.exit(1); }
  }
  if (m.default !== m.BackgroundOps) { console.error("MANIFEST-MISMATCH default is not the BackgroundOps factory (1+default identity)"); process.exit(1); }
  // Loader-shape factory resolve on both entries: each must yield the 7-tool surface.
  const SEVEN = ["background_run", "background_list", "background_status", "background_read", "background_steer", "background_stop", "background_config"];
  for (const entry of plugin) {
    let p;
    try { p = await m[entry]({}); } catch (e) { console.error("MANIFEST-THROW " + entry + " on {}: " + ((e && e.message) || e)); process.exit(1); }
    for (const t of SEVEN) {
      if (typeof p?.tool?.[t]?.execute !== "function") { console.error("MANIFEST-MISSING " + entry + " lacks tool " + t); process.exit(1); }
    }
  }
  console.log("MANIFEST-GUARD green: plugin entries {BackgroundOps,default} (1+default identity) + 0 helpers, 7 tools on both");
  process.exit(0);
}).catch((e) => { console.error("MANIFEST-GUARD import failed: " + ((e && e.message) || e)); process.exit(1); });
'
echo "[loader-guard] manifest-acceptance green"
