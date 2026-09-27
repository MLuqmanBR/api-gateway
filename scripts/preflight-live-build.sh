#!/usr/bin/env bash
#!/usr/bin/env bash
# Pre-flight before building anything for the live gateway.
#
# WHY THIS LIVES IN THE REPO AND NOT IN SCRATCH: the live gateway tree can be
# left checked out on a feature branch, and building there silently deploys
# that branch. This script is the guard against that, so it has to be versioned
# alongside the code it protects — a guard that only exists in a /tmp scratch
# file is not a guard, it is a habit.
#
# Usage:  scripts/preflight-live-build.sh [path-to-repo-root]
# Exit 0 = safe to build. Exit 1 = STOP; do not build, do not restart.
#
# An
# earlier attempt guarded on `grep -q "ensureCatalogInChain" server/src/routes/fallback.ts`,
# which fails on BOTH the fixed and the unfixed tree (PUT no longer calls it), and
# a second attempt guarded on lowercase "insert-only" while the marker in
# chain.ts is uppercase — GNU grep is case-sensitive, so that also matched
# neither. Both were verified by dry run against BOTH trees, which is why the
# probes below are what they are:
#
#   repairChainInvariant  exists only in the unfixed tree (the eraser)
#   INSERT-ONLY           exists only in the fixed tree
#
set -uo pipefail

TREE="${1:-/home/mluqmanbr/LQ/api-gateway}"
fail=0

if grep -rq "repairChainInvariant" "$TREE/server/src" 2>/dev/null; then
  echo "ABORT: '$TREE' still contains repairChainInvariant."
  echo "       That is the eraser that re-enables models the operator switched off"
  echo "       (server/src/db/chain.ts, server/src/routes/fallback.ts)."
  echo "       Building here would re-ship the no-op-toggle bug."
  fail=1
fi

if ! grep -rq "INSERT-ONLY" "$TREE/server/src/db/chain.ts" 2>/dev/null; then
  echo "ABORT: '$TREE/server/src/db/chain.ts' has no INSERT-ONLY marker."
  echo "       The tree is not the fixed one (case-sensitive marker)."
  fail=1
fi

if ! grep -rq "ensureCatalogInChain(db);" "$TREE/server/src/lib/config/import.ts" 2>/dev/null; then
  echo "ABORT: the chain membership pass is missing from lib/config/import.ts."
  echo "       Without it, a models+chain restore strands row-less enabled models."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "PRE-FLIGHT FAILED for $TREE"
  echo "Checked out branch: $(git -C "$TREE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  echo "Do not build. Check out the fixed branch first, then re-run."
  exit 1
fi

echo "PRE-FLIGHT OK: $TREE contains the chain fixes (no eraser, insert-only helpers, import membership pass)."
echo "  branch: $(git -C "$TREE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo "  head:   $(git -C "$TREE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
