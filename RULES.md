# Fork Management Rules — FreeLLMAPI

> **Audience:** AI agents + human maintainers. Follow these rules exactly. Order matters.

---

## 0. Repository Identity

| Role | URL |
|---|---|
| **Your fork** (origin) | `https://github.com/MLuqmanBR/freellmapi.git` |
| **Upstream** (original) | `https://github.com/tashfeenahmed/freellmapi.git` |

```
upstream/main  ←  the canonical upstream. Never commit here directly.
origin/main    ←  mirror of upstream/main. Keep in sync.
origin/feat/*  ←  one branch per custom feature.
test/combined  ←  integration branch: merges all feat/* on top of main.
```

---

## 1. Branch Architecture

### 1.1 Branch Purposes

| Branch | Purpose | Upstream tracking? | Direct commits? |
|---|---|---|---|
| `main` | Mirror of `upstream/main` | Yes | ❌ NEVER |
| `feat/<name>` | One custom feature | No (rebased on main) | ✅ Yes |
| `test/combined` | Integration of all `feat/*` | No | ❌ Merge only |

### 1.2 Naming Convention

Feature branches: `feat/<short-descriptive-slug>`

```
feat/lan-auto-grant              ← good
feat/custom-providers-redesign   ← good
feat/dark-mode                   ← good
custom-stuff                     ← bad (no prefix)
feature/new-thing                ← bad (wrong prefix)
```

### 1.3 Current Feature Branches

```
feat/lan-auto-grant              5f91202   auth: LAN auto-grant
feat/custom-providers-redesign   a115f8e   providers: custom providers as first-class objects
```

### 1.4 What Lives Where

| Code | Where |
|---|---|
| Upstream code (unchanged) | `main` |
| Your custom features | `feat/*` branches |
| Testing merge of all features | `test/combined` |
| Deployment | `test/combined` (or whichever you deploy from) |

---

## 2. Creating a New Feature

### Step-by-step

```bash
# 1. Ensure main is up to date with upstream
git checkout main
git fetch upstream
git merge upstream/main          # should be fast-forward

# 2. Create feature branch from main
git checkout -b feat/my-feature

# 3. Implement the feature
# ... make changes, commit often ...

# 4. Push to your fork
git push -u origin feat/my-feature

# 5. Integrate into test/combined
git checkout test/combined
git merge feat/my-feature
# resolve any conflicts with other feat/* branches
git push origin test/combined

# 6. Test the integration
npm run test
npm run dev                       # manual smoke test
```

### Commit Message Format

```
<type>(<scope>): <description>

feat(auth): LAN auto-grant for loopback/RFC1918 callers
feat(providers): custom providers as first-class platform objects
fix(router): handle null tool_calls on assistant echoes
docs(readme): document custom provider setup
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

### Feature Isolation Rules

1. **One concern per branch.** Don't mix unrelated features. If your change touches auth AND providers, split into two branches.
2. **New files are your friends.** The less you modify existing upstream files, the less merge conflicts you'll have.
3. **Prefer extension over modification.** Add new routes in new files. Use middleware/decorator patterns. Don't rewrite upstream functions.
4. **If you must modify an upstream file, minimize the diff.** Change only what you need, exactly where you need it.

---

## 3. Syncing from Upstream (Critical)

### When to Sync

- **Weekly** — minimum. Set a calendar reminder.
- **Before starting any new feature** — always.
- **When upstream releases something you need** — immediately.
- **After noticing a large number of upstream commits** — don't let divergence accumulate.

### How to Check if You're Behind

```bash
git fetch upstream
git log --oneline main..upstream/main
# If output appears → you're behind → sync NOW
```

### Full Sync Procedure

```bash
# === PHASE 1: Update main ===
git checkout main
git fetch upstream
git merge upstream/main
# This merges upstream/main into your local main.
# It MUST be a fast-forward. If it's not, investigate.
git push origin main

# === PHASE 2: Rebase each feature branch ===
# Do this ONE branch at a time. Resolve fully before moving to the next.

# For feat/lan-auto-grant:
git checkout feat/lan-auto-grant
git rebase main
# Resolve conflicts if any → git add . → git rebase --continue
# Run tests
npm run test
# Push (force is needed because rebase rewrites history)
git push --force-with-lease origin feat/lan-auto-grant

# For feat/custom-providers-redesign:
git checkout feat/custom-providers-redesign
git rebase main
# Resolve conflicts if any → git add . → git rebase --continue
npm run test
git push --force-with-lease origin feat/custom-providers-redesign

# === PHASE 3: Rebuild test/combined ===
git checkout test/combined
git reset --hard main
git merge feat/lan-auto-grant
git merge feat/custom-providers-redesign
# Resolve cross-feature conflicts if any
npm run test
git push --force-with-lease origin test/combined
```

### ❌ NEVER Do This

```bash
# NEVER merge upstream into a feature branch
git checkout feat/my-feature
git merge upstream/main          # ❌ BAD — creates merge commits, destroys rebaseability

# NEVER merge upstream into test/combined
git checkout test/combined
git merge upstream/main          # ❌ BAD — same reason

# NEVER commit directly to main
git checkout main
# ... make changes ...           # ❌ BAD — main is upstream mirror only
git commit -m "fix stuff"        # ❌ BAD
```

### ✅ Always Do This

```bash
git checkout main
git merge upstream/main          # ✅ fast-forward only
git rebase main feat/my-feature  # ✅ linear history
git checkout test/combined
git reset --hard main            # ✅ clean rebuild
git merge feat/my-feature        # ✅ clean integration
```

---

## 4. Conflict Resolution Guide

### 4.1 Conflict Hotspots (files you modify that upstream also touches)

| File | Your Features Touching It | Risk Level |
|---|---|---|
| `server/src/app.ts` | BOTH features | 🔴 HIGH |
| `server/src/db/index.ts` | custom-providers-redesign | 🔴 HIGH |
| `server/src/db/migrations.ts` | custom-providers-redesign (indirect) | 🔴 HIGH |
| `server/src/providers/index.ts` | custom-providers-redesign | 🟡 MEDIUM |
| `server/src/services/router.ts` | custom-providers-redesign | 🟡 MEDIUM |
| `shared/types.ts` | custom-providers-redesign | 🟡 MEDIUM |
| `server/src/routes/keys.ts` | custom-providers-redesign | 🟡 MEDIUM |
| `server/src/middleware/requireAuth.ts` | lan-auto-grant | 🟢 LOW |
| `server/src/routes/auth.ts` | lan-auto-grant | 🟢 LOW |
| `client/src/App.tsx` | lan-auto-grant | 🟢 LOW |

### 4.2 New Files You Added (zero conflict risk)

```
server/src/routes/custom.ts       ← custom-providers-redesign
server/src/lib/ip-trust.ts        ← lan-auto-grant
server/src/__tests__/routes/custom-providers.test.ts
server/src/__tests__/routes/requireAuth.test.ts
```

### 4.3 Resolution Strategy Per Feature

#### feat/custom-providers-redesign

**Problem:** Your migration `migrateCustomProvidersV24()` lives in `db/index.ts`. Upstream refactored all migrations into `db/migrations.ts`. During rebase, `db/index.ts` will conflict because upstream deleted the migration functions you added code to.

**Resolution during rebase:**

1. When rebase hits `db/index.ts` conflict:
   - Accept upstream's version of `initDb()` (which calls `migrateDbSchema(db)` instead of inline migrations)
   - Your `custom_providers` CREATE TABLE statement must move into `migrations.ts`
   - Your `migrateCustomProvidersV24()` function must move into `migrations.ts`

2. In `server/src/db/migrations.ts` (the new upstream file):
   - Add your `custom_providers` CREATE TABLE in `createTables()` function
   - Add your `migrateCustomProvidersV24()` function
   - Add `migrateCustomProvidersV24(db)` call in `migrateDbSchema()` — AFTER `migrateEmbeddingsV1(db)` and BEFORE `ensureUnifiedKey(db)`

3. In `server/src/services/router.ts`:
   - Your change: `buildProviderFor(entry.platform)` replaces `getProvider(entry.platform)`
   - Upstream change: added `skipModels?: Set<number>` parameter and check
   - These touch different lines → likely merge clean. If conflict, accept both.

4. All other files (`providers/index.ts`, `routes/keys.ts`, `shared/types.ts`, `health.ts`, `app.ts`, `client/KeysPage.tsx`):
   - Your changes are complete replacements of small sections
   - Resolve by accepting your version
   - If upstream also changed the same section (rare), merge manually

#### feat/lan-auto-grant

**Problem:** Almost none. This feature adds 1 new file (`ip-trust.ts`) and makes targeted changes to `requireAuth.ts`, `auth.ts`, `app.ts`, and client files.

**Resolution:** Usually clean rebase. If `app.ts` conflicts, your `TRUST_PROXY` block and the `customRouter` mount (from the other feature) need to coexist. Accept both blocks.

### 4.4 Conflict Resolution Checklist

When rebase pauses for conflict:

```
□ git status                        — see conflicted files
□ For each conflicted file:
  □ Open file, find <<<<<<< markers
  □ Understand what your change does vs upstream's
  □ Choose correct resolution (your version / upstream / manual merge)
  □ Remove conflict markers
□ git add <resolved files>
□ git rebase --continue
□ npm run test                      — MUST PASS before pushing
□ If tests fail: fix, amend, continue
```

---

## 5. Testing

### 5.1 Run Tests After Every Significant Change

```bash
# Full test suite
npm run test

# Server only
npm run test -w server

# Client only
npm run test -w client --if-present
```

### 5.2 Manual Smoke Test

```bash
# Start dev server + client
npm run dev

# Verify:
# 1. Dashboard loads on LAN (lan-auto-grant feature)
# 2. Custom providers page works (custom-providers feature)
# 3. Send a chat request through the proxy
```

### 5.3 Test After Upstream Sync (Mandatory)

```
After rebase:
  □ npm run test          — all tests pass
  □ npm run dev           — manual smoke test
  □ If anything fails → DO NOT PUSH → fix first
```

---

## 6. Before Committing: Self-Check

```
□ Am I on a feat/* branch? (not main, not test/combined)
□ Did I fetch upstream and check if I'm behind?
□ Did I write tests for new behavior?
□ Did I run the full test suite?
□ Is my commit message in conventional commit format?
□ Does my change touch a file that upstream modifies?
  → If yes: Am I prepared for a conflict at next rebase?
```

---

## 7. Quick Reference Commands

```bash
# Check status
git fetch upstream
git log --oneline main..upstream/main    # commits upstream has that you don't
git log --oneline upstream/main..main    # (should be empty — main == upstream)

# List all feature branches
git branch | grep feat/

# See what a feature branch changes vs upstream
git diff upstream/main...feat/lan-auto-grant --stat
git diff upstream/main...feat/custom-providers-redesign --stat

# Full sync (when behind upstream)
git checkout main && git merge upstream/main && git push origin main
git checkout feat/lan-auto-grant && git rebase main && npm test && git push --force-with-lease origin feat/lan-auto-grant
git checkout feat/custom-providers-redesign && git rebase main && npm test && git push --force-with-lease origin feat/custom-providers-redesign
git checkout test/combined && git reset --hard main && git merge feat/lan-auto-grant feat/custom-providers-redesign && npm test && git push --force-with-lease origin test/combined

# Create new feature
git checkout main && git fetch upstream && git merge upstream/main
git checkout -b feat/new-feature
# ... implement ...
git push -u origin feat/new-feature

# Add new feature to test/combined
git checkout test/combined
git merge feat/new-feature
npm test
git push origin test/combined
```

---

## 8. Anti-Patterns (Don't Do These)

| Anti-Pattern | Why It's Bad |
|---|---|
| `git merge upstream/main` into a feat branch | Creates merge commits. Rebase instead. |
| Multiple features in one branch | Can't rebase independently. Can't revert one without the other. |
| Committing to main directly | main must stay identical to upstream/main. |
| `push --force` on main | Destroys upstream tracking. Use `--force-with-lease` on feat/* only. |
| Skipping tests after rebase | Conflicts can silently break things. |
| Letting divergence accumulate >2 weeks | Each week of delay = more conflicts to resolve at once. |
| Copying upstream files into feat branches | Rebase handles this. Copying = duplication hell. |
| Squashing feature commits into one during rebase | Keep granular commits within the feature branch. Each commit tells a story. |

---

## 9. Project-Specific Notes

### 9.1 Known Integration Points

- **`server/src/app.ts`** — Both features mount middleware/routers. The `customRouter` is mounted with a path-aware `requireAuth` guard. The `TRUST_PROXY` setting goes before all middleware. If upstream adds new routes here, merge manually.

- **`server/src/providers/index.ts`** — Your `buildProviderFor()` replaces the old `resolveProvider()`. If upstream adds new providers or changes the registration pattern, verify that `buildProviderFor` still works for built-in platforms.

- **`shared/types.ts`** — You widened `Platform` from a union type to `string` for `Model.platform` and `ApiKey.platform`. If upstream adds new platform literals, confirm your widened types still compile.

### 9.2 Migration Numbering

Your `migrateCustomProvidersV24` uses the V24 number. When upstream adds V25, V26, etc., your migration function name is fine as-is — these are just function names, not version identifiers that conflict. But if upstream creates a `migrateModelsV24` with a different purpose, rename yours to avoid confusion.

### 9.3 Database Schema

Your `custom_providers` table:
```sql
CREATE TABLE IF NOT EXISTS custom_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

This table is **only in your fork**. Upstream will never create it. Your migration handles it idempotently. When porting to `migrations.ts`, keep the CREATE TABLE in `createTables()` and the migration function separate.

---

## 10. Emergency Recovery

### "I messed up a rebase"

```bash
# Abort the rebase
git rebase --abort

# Your branch is back to where it was before the rebase.
# Try again, slower this time.
```

### "I force-pushed wrong to main"

```bash
# Reset main to upstream's version
git checkout main
git fetch upstream
git reset --hard upstream/main
git push --force-with-lease origin main
```

### "test/combined is broken after merge"

```bash
# Rebuild from scratch
git checkout main
git pull upstream main
git checkout test/combined
git reset --hard main
git merge feat/lan-auto-grant
# If this passes tests:
npm test
git merge feat/custom-providers-redesign
# If this passes tests:
npm test
git push --force-with-lease origin test/combined
```

### "I accidentally committed to main"

```bash
# If not yet pushed:
git reset HEAD~1
git stash
git checkout -b feat/recovered-feature
git stash pop

# If already pushed (worse):
git reset --hard upstream/main
git push --force-with-lease origin main
```

---

*Last updated: 2026-06-08*
*Features tracked: feat/lan-auto-grant, feat/custom-providers-redesign*