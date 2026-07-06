import type Database from 'better-sqlite3';

/** Discriminated result of resolving a client-pinned `model` field to a
 *  concrete `models.id`. The chat (`/v1/chat/completions`) and responses
 *  (`/v1/responses`) routes both call this so resolution stays in one place.
 *  - `resolved`     → exactly one enabled model row matched. Use `modelDbId`.
 *  - `not_found`    → no enabled row, and no disabled row either. The id is
 *                    genuinely absent from the catalog.
 *  - `disabled`     → no enabled row, but a disabled row exists (so the
 *                    message can say "is disabled", not "is not in the catalog").
 *  - `ambiguous`    → the pin matches ≥2 enabled rows across different
 *                    platforms. The pin is silently cross-platform; reject it
 *                    and surface `platforms` so the client can re-pin with a
 *                    `platform/model_id` prefix. */
export type PinnedModelResolution =
  | { kind: 'resolved'; modelDbId: number }
  | { kind: 'not_found' }
  | { kind: 'disabled' }
  | { kind: 'ambiguous'; platforms: string[] };

/** The `api-gateway/` extension prefix the OMP additional-providers-extension
 *  prepends to every advertised id so OMP's resolver doesn't pick a native
 *  provider that shares the underlying model name. Stripped before resolution. */
const EXTENSION_PREFIX = 'api-gateway/';

/** Resolve a client-pinned `model` to a `models.id`, or to an explicit
 *  not-found / disabled / ambiguous verdict the caller can surface as 400.
 *
 *  `db` is the gateway's better-sqlite3 handle (the caller already has it via
 *  `getDb()`). `requestedModel` is the raw `model` field as the client sent it
 *  (still carrying the optional `api-gateway/` prefix). */
export function resolvePinnedModel(db: Database.Database, requestedModel: string): PinnedModelResolution {
  let workingModel = requestedModel;
  if (workingModel.startsWith(EXTENSION_PREFIX)) {
    workingModel = workingModel.slice(EXTENSION_PREFIX.length);
  }

  const slashIdx = workingModel.indexOf('/');

  // Path A: the client used the documented `platform/model_id` wire form (the
  // shape /v1/models advertises). When the first segment IS a real platform AND
  // that platform+model pair exists, this is the explicit-platform choice — it
  // resolves uniquely and is never ambiguous, even when the same model_id is
  // served by other platforms. When that exact platform+model is disabled we
  // surface `disabled` (NOT ambiguous) so the user fixes the RIGHT thing.
  // When the first segment ISN'T a real platform (e.g. `MiniMaxAI/MiniMax-M3`,
  // where the WHOLE string is the stored `model_id` across huggingface +
  // commandcode), the platform-qualified query misses AND there's no disabled
  // sibling → fall through to Path B and try the full string as a bare model_id.
  if (slashIdx > 0) {
    const platform = workingModel.slice(0, slashIdx);
    const modelId = workingModel.slice(slashIdx + 1);
    const enabled = db.prepare(
      'SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1',
    ).get(platform, modelId) as { id: number } | undefined;
    if (enabled) return { kind: 'resolved', modelDbId: enabled.id };
    const disabled = db.prepare(
      'SELECT id FROM models WHERE platform = ? AND model_id = ?',
    ).get(platform, modelId) as { id: number } | undefined;
    if (disabled) return { kind: 'disabled' };
    // Otherwise: the first segment wasn't a real platform the client pinned.
    // Fall through to Path B with the full working string.
  }

  // Path B: try the full working string as a bare `model_id`. Match enabled
  // rows on model_id alone. When exactly one platform serves this id the bare
  // form stays a backward-compat shorthand. When two-or-more platforms share
  // the id the pin is silently cross-platform — return `ambiguous` and let the
  // caller 400 it (resolving to rowid-first, as the prior code did, can route
  // the request to a platform with zero healthy keys and spin the recovery
  // loop forever).
  const enabledRows = db.prepare(
    'SELECT id, platform FROM models WHERE model_id = ? AND enabled = 1',
  ).all(workingModel) as Array<{ id: number; platform: string }>;
  if (enabledRows.length === 1) return { kind: 'resolved', modelDbId: enabledRows[0]!.id };
  if (enabledRows.length >= 2) {
    return { kind: 'ambiguous', platforms: enabledRows.map(r => r.platform) };
  }

  // No enabled row. Was it disabled, or genuinely absent?
  const disabledRow = db.prepare(
    'SELECT id FROM models WHERE model_id = ?',
  ).get(workingModel) as { id: number } | undefined;
  return disabledRow ? { kind: 'disabled' } : { kind: 'not_found' };
}
