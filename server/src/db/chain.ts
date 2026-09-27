import type { DatabasePort } from './types.js';

/**
 * The chain invariant: a model the operator has ENABLED must have a
 * `fallback_config` ROW.
 *
 * That is deliberately a statement about MEMBERSHIP, not about the `enabled`
 * column. Those are two different things and conflating them is what made the
 * Fallback page's checkboxes no-ops:
 *
 *   - membership  (does a fallback_config row exist)  -> a structural fact the
 *     server is responsible for. Writers that add an enabled model must create
 *     the row, or routeRequest's chain (router.ts) can never see the model.
 *   - fc.enabled   (is that row switched on)         -> the operator's explicit,
 *     reversible choice. NOTHING in the server may set it back to 1 behind
 *     their back.
 *
 * An earlier version of this file repaired the invariant by re-enabling
 * `fc.enabled = 0` rows whose model was catalog-enabled. That is unsound: a
 * full-replace PUT that the operator used to narrow the chain is byte-identical
 * to one sent by a stale tab, so no SQL predicate can tell the two apart. The
 * repair therefore undid deliberate disables — the user toggles a model off,
 * saves, and it silently comes back on. The narrower membership form below is
 * both sufficient and safe.
 *
 * Disabling stays asymmetric on purpose: it never removes the row, so the
 * model's priority survives a re-enable.
 */

// The real port, not a structural stand-in: the native and sql.js backends
// differ in their result wrappers, and a hand-rolled shape silently diverges.
type Db = DatabasePort;

/**
 * Put a model in the chain if it has no row yet. INSERT-ONLY.
 *
 * It never touches `fc.enabled` on a row that already exists, in any caller and
 * under any option. `fc.enabled` is the operator's switch; a server-side helper
 * re-enabling it is the same defect the Fallback page reported ("I disable a
 * model and it comes straight back on"), just reached through a different
 * endpoint. A model switched off in the chain must STAY off until the operator
 * switches it back on or explicitly re-enables the model itself.
 *
 * This is sufficient rather than a compromise: every path that can end up
 * with a missing row either leaves it absent — so this insert is exactly the
 * repair needed — or has its own, explicit restore. See
 * ensurePlatformInChain and ensureCatalogInChain for those two.
 *
 * @returns 'present' when a row already existed (untouched), 'appended' when
 *   one was created.
 */
export function ensureInChain(
  db: Db,
  modelDbId: number,
): 'present' | 'appended' {
  const existing = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId);
  if (existing) return 'present';
  const maxPriority = (db
    .prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config')
    .get() as { m: number }).m;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)')
    .run(modelDbId, maxPriority + 1);
  return 'appended';
}

/**
 * Put every ENABLED model on a platform into the chain if it has no row yet.
 *
 * Called by the provider revive path, and needed for two states that a current
 * database can still be in:
 *   - a provider archived by an OLDER build, which deleted the platform's chain
 *     rows outright. Those rows are gone and this restores them.
 *   - models discovered or added while the platform was archived, which never
 *     had a row to begin with.
 *
 * Archive no longer deletes chain rows (see routes/custom.ts): it only sets
 * `models.enabled = 0`, which already makes the platform unroutable and already
 * preserves the operator's priorities and selection across an archive/revive
 * round trip. So on a current build this is normally a no-op — which is the
 * point. A model the operator switched OFF stays off, because this only ever
 * inserts rows for models that have none.
 *
 * @returns the number of models this call had to add a row for.
 */
export function ensurePlatformInChain(db: Db, platform: string): number {
  const missing = db.prepare(`
    SELECT m.id FROM models m
     WHERE m.platform = ?
       AND m.enabled = 1
       AND NOT EXISTS (SELECT 1 FROM fallback_config fc WHERE fc.model_db_id = m.id)
  `).all(platform) as Array<{ id: number }>;
  for (const { id } of missing) ensureInChain(db, id);
  return missing.length;
}

/**
 * Membership repair: give every catalog-enabled model a chain row, without
 * touching `fc.enabled` on any row that already exists.
 *
 * This is the invariant `PUT /api/fallback` runs inside its transaction. It
 * repairs models that no page ever showed (added by a PATCH or a discovery run
 * while a dashboard tab was open) while leaving every deliberate disable
 * untouched, so an operator can narrow the chain to exactly the models they
 * want and have that stick.
 *
 * Inserted rows are `enabled = 1`: a model that is catalog-enabled and has no
 * chain row at all has never been seen by the operator, so there is no
 * preference to preserve — and leaving it unroutable is the failure mode this
 * function exists to prevent.
 *
 * @returns the number of rows created.
 */
export function ensureCatalogInChain(db: Db): number {
  const missing = db.prepare(`
    SELECT m.id FROM models m
     WHERE m.enabled = 1
       AND NOT EXISTS (SELECT 1 FROM fallback_config fc WHERE fc.model_db_id = m.id)
  `).all() as Array<{ id: number }>;
  if (missing.length === 0) return 0;

  // A single INSERT ... SELECT rather than a loop of individual binds: the set
  // can be the whole catalog, and this keeps the statement's parameter count at
  // zero (the previous NOT IN (... 3.9k placeholders) form relied on the SQLite
  // host parameter limit, which is not guaranteed across backends).
  //
  // ROW_NUMBER() must sit in the OUTER select's window. Wrapping it in a scalar
  // subquery (`? + (SELECT ROW_NUMBER() OVER (ORDER BY m.id))`) makes it
  // evaluate over a single virtual row, so every inserted model is handed the
  // SAME priority and they all tie at the tail — verified against SQLite 3.53,
  // not assumed.
  const maxPriority = (db
    .prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config')
    .get() as { m: number }).m;
  const res = db.prepare(`
    INSERT INTO fallback_config (model_db_id, priority, enabled)
    SELECT m.id, ? + ROW_NUMBER() OVER (ORDER BY m.id), 1
      FROM models m
     WHERE m.enabled = 1
       AND NOT EXISTS (SELECT 1 FROM fallback_config fc WHERE fc.model_db_id = m.id)
  `).run(maxPriority);
  return (res as { changes?: number }).changes ?? missing.length;
}
