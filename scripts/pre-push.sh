#!/bin/sh
# ocbg pre-push hook — structural test-before-landing enforcement.
#
# Blocks every push unless the suite is green:
#   1. npm run typecheck  (tsc --noEmit, must exit 0)
#   2. npm test           (vitest run, must exit 0)
#
# Any non-zero exit blocks the push (git pre-push semantics).
# Install: sh scripts/install-hooks.sh  (copies this file to .git/hooks/pre-push)
# Source of truth: this file. The installed copy in .git/hooks/ is a deploy
# artifact — never edit it in place, re-run the installer instead.

set -eu

echo "[pre-push] ocbg gate: typecheck + tests (red blocks push)"

npm run typecheck
echo "[pre-push] typecheck green"

npm test
echo "[pre-push] tests green"

echo "[pre-push] gate passed — push allowed"
