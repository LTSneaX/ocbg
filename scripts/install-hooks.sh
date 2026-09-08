#!/bin/sh
# Install repo-tracked git hooks into .git/hooks/.
# Usage: sh scripts/install-hooks.sh
# Idempotent: safe to re-run after cloning or pulling hook updates.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cp "$REPO_ROOT/scripts/pre-push.sh" "$REPO_ROOT/.git/hooks/pre-push"
chmod +x "$REPO_ROOT/.git/hooks/pre-push"

echo "installed: .git/hooks/pre-push (executable, blocks push on red suite)"
