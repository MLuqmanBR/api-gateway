# Fork Management Rules — FreeLLMAPI

> **Audience:** AI agents + human maintainers. Follow these rules exactly. Order matters.
> 
> **Last updated:** 2026-06-08 after a major rebase of 2 feature branches through upstream's
> migration refactor (V24→V25). Lessons from every conflict, every wrong turn, and every
> recovery are baked into this document.

---

## 0. Repository Identity

| Role | URL |
|---|---|
| **Your fork** (origin) | `https://github.com/MLuqmanBR/freellmapi.git` |
| **Upstream** (original) | `https://github.com/tashfeenahmed/freellmapi.git` |

```
upstream/main  ←  the canonical upstream. Never commit here directly.
origin/main    ←  deployable: upstream mirror + all custom features merged in.
origin/feat/*  ←  one branch per custom feature.
test/combined  ←  integration scratchpad: merges all feat/* for testing.
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
feat/lan-auto-grant              cf20159   auth: LAN auto-grant
feat/custom-providers-redesign   4754e3e   providers: custom providers as first-class objects
```

### 1.4 Features on main (deployable)

Beyond the two structural branches above, these capabilities are live on `main`:

| Feature | Implementation |
|---|---|
| LAN auto-grant | `ip-trust.ts`, `requireAuth.ts`, `auth.ts` |
| Custom providers (CRUD) | `custom.ts`, `providers/index.ts` |
| Provider-level parallel request gating | `router.ts`, `types.ts`, `custom.ts`, `KeysPage.tsx` |
| Model auto-discovery from provider /models | `custom.ts` (syncModelsFromProvider) |
| Model editing (including built-in models) | `custom.ts`, `FallbackPage.tsx` (EditModelModal) |
| /v1/models filtering (fallback-config + active keys) | `proxy.ts` |
| Provider rate limits (rpm/rpd/tpm/tpd) | `types.ts`, `custom.ts`, `db/migrations.ts` |

### 1.5 What Lives Where

| Code | Where |
|---|---|
| Upstream code (unchanged) | `main` |
| Your custom features (individual) | `feat/*` branches |
| All features merged for testing | `test/combined` |
| Deployable production code | `main` (after merge from test/combined) |

**Key rule:** `main` IS the deployable branch. It contains upstream + all custom features.
This means after testing on `test/combined`, merge everything into `main` and deploy from `main`.

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

### 4.0 The Golden Rules (Learned the Hard Way)

These rules come from solving 11 real conflicts across 2 branches during a
single rebase session. Follow them in order.

1. **NEVER overwrite entire files from old commits.** Old versions lack upstream
   changes. Use targeted `edit` operations instead. Full-file overwrites
   cost 9+ test failures and hours of recovery.

2. **When upstream MOVES code between files, follow the move.** If upstream
   extracts migrations from `db/index.ts` → `db/migrations.ts`, YOUR migrations
   must move too. Don't fight the refactor — embrace it.

3. **Rebase ONE branch at a time.** Resolve completely before touching the next.
   Mixing rebase sessions is how features get lost.

4. **After every conflict resolution, run tests BEFORE `rebase --continue`.**
   Finding a SQL ambiguity at commit-time is painful; finding it after the
   whole rebase is done is catastrophic.

5. **Cherry-pick is NOT a reliable strategy across upstream refactors.**
   Old commits reference old file structures. Cherry-pick works when the
   target files haven't been moved or significantly rewritten. When they have,
   reconstruct the feature manually with targeted edits.

6. **`git checkout --ours/--theirs` is dangerous during rebase.** The meaning
   flips: `--ours` = the branch you're rebasing ONTO (main), `--theirs` =
   the commits being applied (your feature). Double-check with `git status`
   and confirm which version you actually want.

7. **Preserve upstream additions in shared files.** If upstream added a field
   like `reasoning_content` to `ChatMessage`, your rebased `types.ts` must
   keep it. Overwriting with an old version silently removes upstream features.

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

#### feat/custom-providers-redesign — THE HARD ONE

This feature hits the most conflict-prone files. Below is the actual battle plan
from the 2026-06-08 rebase.

##### Conflict 1: `server/src/db/index.ts`

**What happened:** Upstream (commit `6f5f765`) extracted ALL migration functions
from `db/index.ts` into a new `db/migrations.ts`. `initDb()` now calls a single
`migrateDbSchema(db)` instead of a chain of inline `migrateXxx(db)` calls. Meanwhile,
your feature branch added `custom_providers` CREATE TABLE and `migrateCustomProvidersV24`
inline in `db/index.ts`.

**The wrong way (don't do this):**
```bash
git checkout --theirs db/index.ts   # ❌ Grabs YOUR version, losing upstream refactor
git checkout --ours db/index.ts     # ❌ Grabs upstream only, losing custom_providers
```

**The right way:**

1. Accept upstream's version completely:
   ```bash
   git show main:server/src/db/index.ts > server/src/db/index.ts
   git add server/src/db/index.ts
   ```

2. In `server/src/db/migrations.ts` (upstream's new home for migrations):
   - **Add `custom_providers` CREATE TABLE** inside `createTables()` after the
     last index:
     ```sql
     CREATE TABLE IF NOT EXISTS custom_providers (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       slug TEXT NOT NULL UNIQUE,
       display_name TEXT NOT NULL,
       base_url TEXT NOT NULL,
       rpm_limit INTEGER,
       rpd_limit INTEGER,
       tpm_limit INTEGER,
       tpd_limit INTEGER,
       max_parallel_requests INTEGER,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );
     ```
   - **Add `ensureCustomProvidersMaxParallelColumn(db)`** call after the other
     `ensure*` calls in `createTables()`. This is needed for existing DBs that
     were created before `max_parallel_requests` was added.
   - **Add `migrateCustomProvidersV24(db)` call** inside `migrateDbSchema()`,
     after `migrateEmbeddingsV1(db)` and before `ensureUnifiedKey(db)`.
   - **Add the `migrateCustomProvidersV24` function** — it promotes the legacy
     `'custom'` platform slug to a custom_providers row. Copy it verbatim from
     your old `db/index.ts`.

3. **Verify:** `grep custom_providers server/src/db/migrations.ts` should show
   the CREATE TABLE, the migration call, and the function definition.

##### Conflict 2: `server/src/services/router.ts`

**What happened:** Your feature replaced `getProvider(entry.platform)` with
`buildProviderFor(entry.platform)`. Upstream added a TPM budget guard and
`skipModels` parameter. Both changes are in the same `routeRequest()` function
but on different lines.

**Resolution:**
- Keep upstream's TPM guard (lines before the provider resolution)
- Keep YOUR `buildProviderFor` call instead of `getProvider`
- Merge the comments: upstream's comment about TPM + your comment about
  custom_providers lookup
- The `buildProviderFor` import from `../providers/index.js` should already
  be present from the auto-merge.

**Resulting merged code:**
```typescript
// TPM guard (from upstream)
if (entry.tpm_limit != null && estimatedTokens > entry.tpm_limit) continue;

// Provider resolution (from your feature)
const provider = buildProviderFor(entry.platform);
if (!provider) continue;
```

##### Conflict 3: `server/src/routes/proxy.ts` — /v1/models SQL query

**What happened:** Your feature adds a `JOIN fallback_config` to filter models
by fallback enabled status AND removes the legacy `key_id` binding check.

**Critical SQL lesson:** When you add a JOIN and the joined table has an `id`
column, `id` becomes AMBIGUOUS in ORDER BY, ROW_NUMBER() OVER, and other clauses.
The error is `ambiguous column name: id` or `no such column: m.id`.

**The fix:** Use `EXISTS` subquery instead of JOIN:
```sql
-- ✅ CORRECT — no column ambiguity
FROM models m
WHERE m.enabled = 1
  AND EXISTS (
    SELECT 1 FROM fallback_config fc
    WHERE fc.model_db_id = m.id AND fc.enabled = 1
  )

-- ❌ WRONG — id is ambiguous (both m.id and fc.id exist)
FROM models m
JOIN fallback_config fc ON fc.model_db_id = m.id
WHERE m.enabled = 1 AND fc.enabled = 1
```

Also: NEVER use table-qualified columns (`m.id`) in the outer ORDER BY of a
subquery — the alias doesn't carry through. Use unqualified `id`.

```sql
-- ❌ WRONG — m.id doesn't exist in outer scope
) WHERE rn = 1 ORDER BY intelligence_rank ASC, m.id ASC

-- ✅ CORRECT
) WHERE rn = 1 ORDER BY intelligence_rank ASC, id ASC
```

##### Conflict 4: `shared/types.ts` — Preserving upstream additions

**What happened:** Your feature added `rpmLimit`, `rpdLimit`, `tpmLimit`,
`tpdLimit`, `maxParallelRequests` to `CustomProvider` interfaces. Upstream added
`reasoning_content?: string` to `ChatMessage` (for DeepSeek thinking traces, #255).

**The danger:** If you overwrite `types.ts` with an old version (e.g., from
`git show e83e0f8:shared/types.ts`), the `reasoning_content` field is silently
removed. Tests will fail because proxy-tools tests expect it to round-trip.

**The right way:** Apply your additions with targeted edits to the CURRENT
version of the file. Never replace the whole file.

```bash
# ❌ WRONG — loses upstream reasoning_content
git show e83e0f8:shared/types.ts > shared/types.ts

# ✅ CORRECT — apply only your changes with edit tool
git diff main...feat/custom-providers-redesign -- shared/types.ts
# Then manually add those specific lines to the current file
```

#### feat/lan-auto-grant — THE EASY ONE

**Problem:** Almost none. This feature adds 1 new file (`ip-trust.ts`) and makes
targeted changes to `requireAuth.ts`, `auth.ts`, `app.ts`, and client files.

**Resolution:** Usually clean rebase. If `app.ts` conflicts, your `TRUST_PROXY`
block and the `customRouter` mount (from the other feature) need to coexist.
Accept both blocks.

### 4.4 Full Rebase Walkthrough (Step-by-Step)

This is the exact sequence used for the 2026-06-08 rebase. Follow this pattern
for every upstream sync.

#### Phase 1: Update main

```bash
git checkout main
git fetch upstream
git merge upstream/main           # fast-forward only
git push origin main
```

#### Phase 2: Rebase each feature branch (do NOT parallelize)

```bash
# ─── feat/lan-auto-grant (easy, do first for a quick win) ───
git checkout feat/lan-auto-grant
git rebase main
# Usually clean. If conflict:
#   git diff --name-only --diff-filter=U  → see conflicted files
#   resolve → git add → git rebase --continue
npm run test -w server              # MUST PASS
git push --force-with-lease origin feat/lan-auto-grant

# ─── feat/custom-providers-redesign (hard, takes multiple rounds) ───
git checkout feat/custom-providers-redesign
git rebase main
# Conflicts expected in:
#   server/src/db/index.ts         → resolve per §4.3 Conflict 1
#   server/src/services/router.ts  → resolve per §4.3 Conflict 2
# Resolve ONE at a time:
#   edit file → git add → git rebase --continue
# After both resolved:
npm run test -w server              # MUST PASS
git push --force-with-lease origin feat/custom-providers-redesign
```

#### Phase 3: Rebuild test/combined

```bash
git checkout test/combined
git reset --hard main
git merge feat/lan-auto-grant
git merge feat/custom-providers-redesign
npm run test -w server              # MUST PASS
git push --force-with-lease origin test/combined
```

#### Phase 4: Apply session features (NEW work, not yet in any feat/ branch)

```bash
# Stay on test/combined
git checkout test/combined

# Apply each new feature as targeted edits (NEVER overwrite entire files):
# - Parallel request gating → edit router.ts, proxy.ts, responses.ts, types.ts, custom.ts
# - Model auto-discovery → edit custom.ts
# - Model editing → edit custom.ts, FallbackPage.tsx
# - /v1/models filter → edit proxy.ts

npm run test -w server              # MUST PASS after EACH feature

# Commit in logical groups:
git add <files> && git commit -m "feat: <description>"
```

#### Phase 5: Merge to main (deploy)

```bash
git checkout main
git merge test/combined            # fast-forward
git push origin main
```

### 4.5 Conflict Resolution Checklist

When rebase pauses for conflict:

```
□ git status                        — see conflicted files
□ git diff --name-only --diff-filter=U  — just the filenames
□ For each conflicted file:
  □ Open file, find <<<<<<< markers
  □ Understand what your change does vs upstream's
  □ Check: did upstream MOVE code to a different file?
    → If yes: follow the move (see §4.3 Conflict 1)
  □ Check: did upstream ADD new code in the same area?
    → If yes: merge both (see §4.3 Conflict 2)
  □ Choose correct resolution (your version / upstream / manual merge)
  □ Remove conflict markers
  □ For SQL changes: check for ambiguous column names (§4.3 Conflict 3)
  □ For type changes: verify no upstream fields were dropped (§4.3 Conflict 4)
□ git add <resolved files>
□ git diff --cached                  — review what you're about to commit
□ git rebase --continue
□ npm run test -w server              — MUST PASS before pushing
□ If tests fail:
  □ Read the error carefully (the test output tells you what's wrong)
  □ Common post-rebase errors:
    - "ambiguous column name" → SQL JOIN added ambiguous id (§4.3 Conflict 3)
    - "no such column: m.id" → table alias in outer ORDER BY
    - "expected 500 to be 200" → likely SQL syntax error (check stderr)
    - "property X missing" → upstream addition dropped from shared types
  □ Fix → git add → git commit --amend → continue
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
  □ npm run test -w server    — all tests pass (currently 468)
  □ npm run dev               — manual smoke test
  □ If ANYTHING fails → DO NOT PUSH → fix first
  □ Common failure patterns after upstream sync:
    - /v1/models tests fail with 500 → SQL query broken (ambiguous columns)
    - proxy retry tests fail → upstream added new retry helpers; your proxy.ts
      overwrote them. Restore proxy.ts and re-apply your changes with edits.
    - router tests fail → upstream changed RouteResult/routeRequest signature.
      Check for new parameters (skipModels?) and add them to your code.
```

---

## 6. Before Committing: Self-Check

```
□ Am I on a feat/* branch or test/combined? (not pushing to main directly)
□ Did I fetch upstream and check if I'm behind?
  → git fetch upstream && git log --oneline main..upstream/main
□ Did I write tests for new behavior?
□ Did I run the full test suite? (npm run test -w server, expect 468 passing)
□ Is my commit message in conventional commit format?
□ Does my change touch a file that upstream modifies?
  → If yes: Am I prepared for a conflict at next rebase?
  → If yes: Did I minimize my diff footprint on that file?
□ If I edited SQL queries: did I test with an in-memory DB?
  → In-memory DB has seeded models + fallback_config + api_keys from tests.
□ If I edited shared/types.ts: did I preserve all upstream type fields?
  → Compare with: git diff upstream/main -- shared/types.ts
□ If this is a rebase resolution: did I run tests BEFORE git rebase --continue?
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

| Anti-Pattern | Why It's Bad | What Actually Happened |
|---|---|---|
| `git merge upstream/main` into a feat branch | Creates merge commits. Rebase instead. | — |
| Multiple features in one branch | Can't rebase independently. Can't revert one without the other. | — |
| Committing to main directly | main must stay identical to upstream/main. | — |
| `push --force` on main | Destroys upstream tracking. Use `--force-with-lease` on feat/* only. | — |
| Skipping tests after rebase | Conflicts can silently break things. | Skipped tests, got 11 failures later |
| Letting divergence accumulate >2 weeks | Each week of delay = more conflicts to resolve at once. | 23 commits behind → complex migration refactor |
| Copying upstream files into feat branches | Rebase handles this. Copying = duplication hell. | — |
| Squashing feature commits into one during rebase | Keep granular commits within the feature branch. | — |
| **Cherry-picking old commits after upstream refactor** | Old commits reference old file structures (e.g., `db/index.ts` when migrations moved to `db/migrations.ts`). Cherry-pick hits conflicts that are harder to resolve than a rebase. | Cherry-pick of 7bb4280 hit 2 conflicts immediately. Switched to manual reconstruction. |
| **Overwriting entire files from old versions** | Old files lack upstream additions. Overwriting `proxy.ts` with an old version wiped out V25 retry helpers and `reasoning_content` support. 11 test failures. | Took 3 rounds of restore + edit to recover. |
| **`git checkout --theirs` during rebase without understanding direction** | During rebase, `--theirs` = the feature branch being applied, `--ours` = main (the base). Easy to pick the wrong side. | Accidentally used `--theirs` thinking it was main. Had to `rebase --abort` and restart. |
| **Using JOIN instead of EXISTS for filtering in SQL subqueries** | JOIN introduces column ambiguity when both tables have `id` columns. EXISTS avoids the ambiguity entirely. | `ambiguous column name: id` error in /v1/models query. Fixed by switching JOIN → EXISTS. |
| **Replacing shared type files wholesale** | `shared/types.ts` has fields added by upstream (e.g., `reasoning_content`). Overwriting removes them silently. | `reasoning_content` test failed after overwrite. |
| **Not testing between consecutive rebase resolutions** | If you resolve conflict 1, continue, hit conflict 2, and only test at the end — you won't know WHICH resolution broke things. | — |

---

## 9. Project-Specific Notes

### 9.1 Known Integration Points

- **`server/src/app.ts`** — Both features mount middleware/routers. The `customRouter` is mounted with a path-aware `requireAuth` guard. The `TRUST_PROXY` setting goes before all middleware. If upstream adds new routes here, merge manually.

- **`server/src/providers/index.ts`** — Your `buildProviderFor()` replaces the old `resolveProvider()`. If upstream adds new providers or changes the registration pattern, verify that `buildProviderFor` still works for built-in platforms.

- **`server/src/db/migrations.ts`** — ALL migrations live here now (upstream refactored them out of `db/index.ts`). Your custom migrations (`migrateCustomProvidersV24`, custom_providers table, `ensureCustomProvidersMaxParallelColumn`) are injected here. When upstream adds new migrations, add your custom code to the same file in the correct order.

- **`shared/types.ts`** — You widened `Platform` from a union type to `string` for `Model.platform` and `ApiKey.platform`. If upstream adds new platform literals, confirm your widened types still compile. The `ChatMessage` interface gains fields over time (e.g., `reasoning_content` in V25). Never drop these.

- **`server/src/services/router.ts`** — Your parallel request gating uses `tryReserveSlot`/`releaseSlot` keyed by platform slug. The `RouteResult` interface has a `release` function. When upstream changes `routeRequest()` signature, ensure your changes to the return value include `release`.

- **`server/src/routes/proxy.ts`** — The `/v1/models` query is customized with fallback_config and api_keys filtering. Use EXISTS subqueries, not JOINs, to avoid column ambiguity.

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
  rpm_limit INTEGER,
  rpd_limit INTEGER,
  tpm_limit INTEGER,
  tpd_limit INTEGER,
  max_parallel_requests INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

This table is **only in your fork**. Upstream will never create it. Your migration handles it idempotently.

Column additions use `ensure*` pattern (e.g., `ensureCustomProvidersMaxParallelColumn`) so
existing DBs get new columns on restart.

### 9.4 Parallel Request Gating Architecture

- **Per-provider, not per-model.** The in-flight counter in `router.ts` is keyed by
  platform slug (string), not model ID. All models under one custom provider share
  a single concurrency cap.
- **Built-in providers are unlimited.** `tryReserveSlot` returns `true` immediately
  when `maxParallel` is null/undefined/≤0.
- **release() must be called in finally blocks.** Both `proxy.ts` and `responses.ts`
  call `route.release()` in `finally` after the retry loop. If you add a new proxy
  route, add the release call.
- **The limit is read from `custom_providers.max_parallel_requests`** at routing time.
  It's NOT cached — changes take effect on the next request.

---

## 10. Emergency Recovery

### "I messed up a rebase"

```bash
# Abort the rebase
git rebase --abort

# Your branch is back to where it was before the rebase.
# Try again, slower this time. Follow §4.4 exactly.
```

### "I force-pushed wrong to main"

```bash
# Reset main to upstream's version
git checkout main
git fetch upstream
git reset --hard upstream/main
git push --force-with-lease origin main

# Then redo the merge from test/combined:
git checkout test/combined
git reset --hard main
git merge feat/lan-auto-grant
git merge feat/custom-providers-redesign
# Re-apply session features from §4.4 Phase 4
npm test
git checkout main && git merge test/combined && git push origin main
```

### "test/combined is broken after merge"

```bash
# Rebuild from scratch
git checkout main
git fetch upstream && git merge upstream/main
git checkout test/combined
git reset --hard main
git merge feat/lan-auto-grant
npm test                                  # If passes:
git merge feat/custom-providers-redesign
npm test                                  # If passes, re-apply session features
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

### "I overwrote a file with an old version and tests are broken"

```bash
# Restore the file to the pre-overwrite state
git checkout HEAD -- path/to/file

# Re-apply your changes with targeted edits (NOT overwrite)
# See §4.3 Conflict 4 for the types.ts example
```

### "The rebase editor opened and I don't know what to do"

```bash
# The editor is asking for a commit message. Skip it:
GIT_EDITOR=true git rebase --continue

# Or set it globally:
git config --global core.editor true
```

## 11. Case Study: The 2026-06-08 Rebase (Full War Story)

> This section captures the actual sequence of events, mistakes, recoveries,
> and lessons from a major rebase session. Read it before attempting any
> non-trivial upstream sync.

### The Situation

- **Upstream:** 23 commits ahead (from `d42380b` to `3acd45a`)
- **Custom features to preserve:**
  1. `feat/lan-auto-grant` (1 commit, clean)
  2. `feat/custom-providers-redesign` (1 commit, complex)
  3. Session features on `test/combined`: parallel gating, auto-discovery,
     model editing, /v1/models filter, RULES.md
- **Main upstream change:** All migrations extracted from `db/index.ts` →
  `db/migrations.ts`. Model catalog refreshed (V24 Zen, V25 dead promos).

### The Plan

1. Update `main` to upstream HEAD
2. Rebase `feat/lan-auto-grant` on main (expected: clean)
3. Rebase `feat/custom-providers-redesign` on main (expected: conflicts)
4. Rebuild `test/combined` from main + rebased feature branches
5. Apply session features on top of test/combined
6. Merge to main

### What Actually Happened

#### Round 1: feat/lan-auto-grant ✅
```bash
git rebase main          # Clean. Zero conflicts.
npm test                 # All 468 passed.
```

#### Round 2: feat/custom-providers-redesign — First Attempt
```bash
git rebase main          # 2 conflicts: db/index.ts, services/router.ts
```

**Mistake 1: Used `--theirs` thinking it was main's version**
```bash
git checkout --theirs server/src/db/index.ts   # ❌ Got OLD feature version
git add server/src/db/index.ts
```
Realized the error, aborted: `git rebase --abort`

**Mistake 2: Tried cherry-picking session commits**
```bash
git cherry-pick 7bb4280   # ❌ Conflict in db/index.ts (old structure)
git cherry-pick --abort
```
Lesson: cherry-pick doesn't work when target files have been refactored.

**Mistake 3: Overwrote files from old test/combined**
```bash
git show e83e0f8:server/src/routes/proxy.ts > server/src/routes/proxy.ts
# ... same for responses.ts, router.ts, fallback.ts, custom.ts, types.ts, etc.
npm test   # 11 FAILURES! Upstream V25 features wiped out.
```

**Recovery:**
```bash
git checkout HEAD -- server/src/routes/proxy.ts server/src/routes/responses.ts server/src/services/router.ts
# Now re-apply changes with TARGETED edits, not file overwrites:
# - proxy.ts: add fc.enabled EXISTS, route.release(), fix SQL ambiguity
# - router.ts: add in-flight tracking, tryReserveSlot, release
# - responses.ts: add route.release() finally
npm test   # 11 → 2 failures
```

#### Round 3: Fixing the 2 Remaining Failures

Both in `proxy-auto-model.test.ts`:
```
[Error] ambiguous column name: id
→ Fixed: m.id AS id in SELECT, changed JOIN to EXISTS

[Error] no such column: m.id
→ Fixed: removed m.id from outer ORDER BY (use unqualified id)

npm test   # 468 passed ✅
```

#### Round 4: Missing reasoning_content

After types.ts was restored, `reasoning_content` was missing from ChatMessage
(dropped during the old-file overwrite). Manually re-added:
```typescript
reasoning_content?: string;  // DeepSeek thinking traces, upstream #255
```

#### Round 5: Commit and Merge

```bash
git add .
git commit -m "feat: parallel gating, auto-discovery, model editing, /v1/models filter"
npm test   # 468 passed ✅
git checkout main
git merge test/combined   # Fast-forward
git push origin main
```

### Key Takeaways

1. **Rebase is the right approach** but requires patience and file-by-file precision.
2. **Targeted edits > file overwrites** — always. One wrong overwrite costs hours.
3. **Test after every resolution** — finding bugs early saves debug time.
4. **EXISTS > JOIN** for SQL subqueries — no column ambiguity.
5. **Cherry-pick is fragile** — only use when target files haven't been refactored.
6. **The rebase direction matters** — `--ours` = main (base), `--theirs` = feature (applied).
7. **Preserve upstream additions** — especially in shared types files.

---

*Last updated: 2026-06-08 after rebasing 2 feature branches through upstream V24→V25 migration refactor.*
*Features tracked: feat/lan-auto-grant, feat/custom-providers-redesign, parallel gating, auto-discovery, model editing, /v1/models filter*