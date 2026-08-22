#!/usr/bin/env bash
# sync-dev.sh — mirror main into dev WITHOUT losing the native Linux app.
#
# Usage:  bash scripts/sync-dev.sh        (run from the repo root, on branch dev)
#
# What it does:
#   1. Merges main into dev (no fast-forward, staged but uncommitted).
#   2. Restores every native-app path that main does not carry, so the
#      deletion on main can never wipe them here.
#   3. Re-checks the three "shared" files main also stripped (ci.yml,
#      README.md, RULES.md) and restores dev's versions of any that lost
#      their desktop content — printing which main commits touched them
#      so nothing web-side is silently dropped.
#   4. Verifies the native tree is complete, then commits the merge.
#
# NOTE for shared files: if main edited ci.yml / README.md / RULES.md in the
# synced range, their web-side edits are listed but NOT auto-applied — port
# them by hand onto dev afterwards (rare; those files change seldom).

set -euo pipefail

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==> WARNING:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==> ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "dev" ] || die "Run this on branch 'dev' (you are on '$BRANCH')."

# ---------- 1) Preconditions ---------------------------------------------------

if [ -n "$(git status --porcelain | grep -v '^.. \.zcode/' || true)" ]; then
  die "Working tree is dirty — commit or stash before syncing."
fi
git rev-parse --verify main >/dev/null 2>&1 || die "No local 'main' branch found."

RANGE="$(git merge-base dev main)..main"
if [ "$(git rev-list --count $RANGE)" = "0" ]; then
  say "dev already contains everything on main — nothing to do."
  exit 0
fi
say "Syncing $(git rev-list --count $RANGE) commit(s) from main ($(git rev-parse --short main))…"

# ---------- 2) Merge, staged but uncommitted ----------------------------------

if ! git merge main --no-ff --no-commit >/dev/null 2>&1; then
  echo
  warn "Merge produced conflicts git could not resolve automatically:"
  git diff --name-only --diff-filter=U | sed 's/^/    CONFLICT: /'
  cat >&8 <<'EOF'

Resolve each conflicted file, KEEPING the native-app content where relevant,
then finish with:  git add -A && git commit
(Or abort with:    git merge --abort)
EOF
  exit 1
fi

# ---------- 3) Restore native-only paths --------------------------------------

NATIVE_PATHS=(
  src/api_gateway_app
  resources
  tests
  pyproject.toml
  README-app.md
  Makefile
  scripts/install.sh
  scripts/uninstall.sh
)

say "Restoring native-app paths stripped by main…"
for p in "${NATIVE_PATHS[@]}"; do
  # Restore only if the merge actually touched/removed it AND dev's HEAD has it.
  if git diff --quiet HEAD -- "$p" 2>/dev/null; then
    continue   # unchanged relative to pre-merge dev — nothing to do
  fi
  if git cat-file -e "HEAD:$p" 2>/dev/null; then
    git checkout HEAD -- "$p"
  else
    warn "'$p' not present in pre-merge dev either — skipping."
  fi
done

# ---------- 4) Guard the three shared files ------------------------------------

SHARED_FILES=(.github/workflows/ci.yml README.md RULES.md)
MARKERS=(
  'name: Python tests'
  '## Desktop app (Linux)'
  'Native desktop app'
)
PORT_LIST=()

for i in "${!SHARED_FILES[@]}"; do
  f="${SHARED_FILES[$i]}"
  marker="${MARKERS[$i]}"
  if [ -f "$f" ] && ! grep -qF "$marker" "$f"; then
    if git show "HEAD:$f" 2>/dev/null | grep -qF "$marker"; then
      git checkout HEAD -- "$f"
      PORT_LIST+=("$f")
    fi
  fi
done

if [ "${#PORT_LIST[@]}" -gt 0 ]; then
  warn "Restored dev-only versions of: ${PORT_LIST[*]}"
  warn "Main-side edits to these files in the synced range (port by hand if needed):"
  for f in "${PORT_LIST[@]}"; do
    git log --oneline HEAD..main -- "$f" | sed 's/^/        /'
  done
fi

# ---------- 5) Integrity check, then commit ------------------------------------

MISSING=0
for p in src/api_gateway_app/app.py pyproject.toml scripts/install.sh resources/desktop/api-gateway.desktop; do
  if [ ! -e "$p" ]; then
    warn "Native path missing after sync: $p"
    MISSING=1
  fi
done
if [ "$MISSING" != "0" ]; then
  die "Native tree incomplete — fix the paths above, then: git add -A && git commit"
fi

git add -A
git commit -q -m "Merge main into dev — preserve native linux app

Web-side changes from main applied; native PyQt6 app, packaging,
installers, resources, python tests and desktop CI job kept intact."
say "Synced. dev is now level with main plus the native app:"
git log --oneline -1
say "Recommended follow-up: cd server && npx vitest run --pool=forks --fileParallelism=false"
