import type { DatabasePort } from '../db/types.js';

/** Discriminated result of resolving a client-pinned `model` field to a
 *  concrete `models.id`. The chat (`/v1/chat/completions`) and responses
 *  (`/v1/responses`) routes both call this so resolution stays in one place.
 *
 *  The wire contract is STRICT: the pin must be `<platform>/<model_id>` (after
 *  stripping one optional `api-gateway/` envelope — see `EXTENSION_PREFIX`).
 *  Nothing else is accepted: no bare-id shorthand, no vendor-namespace pins.
 *
 *  - `resolved`  → the exact `<platform>/<model_id>` pair matched an enabled
 *                  row. `platform`/`modelId` are that row's canonical identity —
 *                  `${platform}/${modelId}` is the display form consumers
 *                  render in place of the raw (client-spelled) pin.
 *  - `malformed` → the pin is not of the required form at all (no slash, an
 *                  empty platform, or an empty model id).
 *  - `not_found` → the pin is well-formed, but no row (enabled or disabled)
 *                  carries that platform+model pair.
 *  - `disabled`  → the exact pair exists but enabled=0, so the message can say
 *                  "is disabled" instead of "is not in the catalog". */
export type PinnedModelResolution =
  | { kind: 'resolved'; modelDbId: number; platform: string; modelId: string }
  | { kind: 'malformed' }
  | { kind: 'not_found' }
  | { kind: 'disabled' };

/** The `api-gateway/` extension prefix the OMP additional-providers-extension
 *  prepends to every advertised id so OMP's resolver doesn't pick a native
 *  provider that shares the underlying model name. It is the ONE sanctioned
 *  envelope: stripped exactly once, before the strict form check. */
const EXTENSION_PREFIX = 'api-gateway/';

/** Resolve a client-pinned `model` to a `models.id`, or to an explicit
 *  malformed / not-found / disabled verdict the caller surfaces as 400.
 *
 *  `db` is the gateway's database handle (the caller already has it via
 *  `getDb()`). `requestedModel` is the raw `model` field as the client sent it
 *  (still carrying the optional `api-gateway/` prefix). */
export function resolvePinnedModel(db: DatabasePort, requestedModel: string): PinnedModelResolution {
  // Strip the extension envelope AT MOST ONCE. `api-gateway/` alone unwraps to
  // the empty string (malformed below), and a doubled envelope leaves
  // `api-gateway/...` whose platform is literally `api-gateway` — no platform
  // in the catalog, so it falls out as not_found rather than being unwrapped
  // again.
  const pin = requestedModel.startsWith(EXTENSION_PREFIX)
    ? requestedModel.slice(EXTENSION_PREFIX.length)
    : requestedModel;

  // Strict form: `<platform>/<model_id>`, split at the FIRST slash so model
  // ids that themselves contain slashes (e.g. `moonshotai/kimi-k2.6`) stay
  // intact. A pin with no slash, an empty platform segment, or an empty model
  // id segment is malformed — there is no bare-id shorthand.
  const slashIdx = pin.indexOf('/');
  if (slashIdx <= 0 || slashIdx === pin.length - 1) return { kind: 'malformed' };

  const platform = pin.slice(0, slashIdx);
  const modelId = pin.slice(slashIdx + 1);

  const enabled = db.prepare(
    'SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1',
  ).get(platform, modelId) as { id: number } | undefined;
  if (enabled) return { kind: 'resolved', modelDbId: enabled.id, platform, modelId };

  // The exact pair missed on enabled rows. Was it disabled, or genuinely absent?
  const disabled = db.prepare(
    'SELECT id FROM models WHERE platform = ? AND model_id = ?',
  ).get(platform, modelId) as { id: number } | undefined;
  return disabled ? { kind: 'disabled' } : { kind: 'not_found' };
}

/** Format a non-resolved `PinnedModelResolution` as the reason string for a
 *  400 `model_not_found` response. Shared by `/chat/completions` and
 *  `/v1/responses` so the wording stays identical. */
export function formatPinnedModelRejection(
  resolution: Exclude<PinnedModelResolution, { kind: 'resolved' }>,
): string {
  if (resolution.kind === 'malformed') {
    return "does not match the required '<platform>/<model_id>' form (e.g. 'groq/llama-3.3-70b-versatile')";
  }
  if (resolution.kind === 'disabled') return 'is disabled';
  return 'is not in the catalog';
}
