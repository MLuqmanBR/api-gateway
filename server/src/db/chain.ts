import type { DatabasePort } from './types.js';

/**
 * The chain invariant: a model the operator has ENABLED must be in the fallback
 * chain.
 *
 * `models.enabled` and `fallback_config.enabled` are two independent columns,
 * and several routes write only one of them. When they drift, the dashboard
 * shows the model as enabled while the router cannot route to it — pinning it
 * returns `400 model_not_routable`, and auto-routing silently skips it. The live
 * catalog reached 1,974 rows in that state.
 *
 * The writers that can strand a model:
 *   - `PUT /api/fallback` — a full replace, so a stale dashboard tab can write
 *     back an old chain with `enabled: 0` for models that have since been enabled.
 *   - provider archive → revive (`custom.ts`) — archive DELETEs every
 *     `fallback_config` row for the platform, revive re-enables the models but
 *     never re-inserts the rows.
 *   - `PATCH /api/custom-models/:id {enabled:true}` — re-enables the model only.
 *
 * Rather than duplicating the repair at each site, they all call the helpers
 * here. Disabling is deliberately NOT symmetric: disabling a model leaves its
 * chain row alone (so its priority survives a re-enable) and simply stops it
 * being routed.
 */

// The real port, not a structural stand-in: the native and sql.js backends
// differ in their result wrappers, and a hand-rolled shape silently diverges.
type Db = DatabasePort;

/**
 * Put a single model back in the chain if it is missing.
 *
 * Preserves an existing row's priority when one is present, so an
 * archive/unarchive round-trip does not silently reorder the operator's chain.
 * A model with no row at all is appended at the tail.
 *
 * @returns 'present' if a row already existed, 'appended' if one was created.
 */
export function ensureInChain(db: Db, modelDbId: number): 'present' | 'appended' {
  const existing = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId);
  if (existing) {
    db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(modelDbId);
    return 'present';
  }
  const maxPriority = (db
    .prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config')
    .get() as { m: number }).m;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)')
    .run(modelDbId, maxPriority + 1);
  return 'appended';
}

/**
 * Put every ENABLED model on a platform back in the chain.
 *
 * Used by the provider revive path, where archive has deleted all of the
 * platform's chain rows. Only touches `models.enabled = 1` rows — a model the
 * operator disabled before the archive must stay out.
 *
 * @returns the number of models the call had to repair.
 */
export function ensurePlatformInChain(db: Db, platform: string): number {
  const stranded = db.prepare(`
    SELECT m.id FROM models m
     WHERE m.platform = ?
       AND m.enabled = 1
       AND NOT EXISTS (SELECT 1 FROM fallback_config fc WHERE fc.model_db_id = m.id)
  `).all(platform) as Array<{ id: number }>;
  for (const { id } of stranded) ensureInChain(db, id);
  return stranded.length;
}

/**
 * Repair the whole catalog: re-enable any chain row whose model is enabled.
 *
 * This is the invariant-repair `PUT /api/fallback` runs inside its transaction,
 * where a stale client payload can otherwise strand models wholesale. Returns
 * the number of rows repaired so the route can report it.
 */
export function repairChainInvariant(db: Db): number {
  const res = db.prepare(`
    UPDATE fallback_config SET enabled = 1
     WHERE enabled = 0
       AND model_db_id IN (SELECT id FROM models WHERE enabled = 1)
  `).run();
  return (res as { changes?: number }).changes ?? 0;
}
