#!/bin/sh
# ocbg loader-contract guard — opencode loads a plugin file only when every
# module-namespace export is a function (or an erased type). A single exported
# number/string/object kills ALL 7 tools at boot with
# "failed to load plugin ... Plugin export is not a function".
#
# This probe builds (tsc emit → dist/src/plugin/background.js) and fails red
# (exit 1, names the tripwire) unless every runtime export is a function.
# Single source of truth: called by scripts/pre-push.sh and .github/workflows/ci.yml.

set -eu

cd "$(dirname "$0")/.."

echo "[loader-guard] building (tsc emit) for probe..."
npx tsc

echo "[loader-guard] probing module-namespace exports..."
node --input-type=module -e "import('./dist/src/plugin/background.js').then(m => { let bad = 0; for (const [k, v] of Object.entries(m)) { if (typeof v !== 'function') { console.error('LOADER-TRIPWIRE ' + k + ' ' + typeof v); bad = 1; } } if (!bad) console.log('LOADER-GUARD green: all exports are functions'); process.exit(bad); })"
