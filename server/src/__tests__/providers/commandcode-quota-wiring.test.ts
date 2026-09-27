/**
 * Wiring lock — deliberately UNMOCKED.
 *
 * health-paid-validation.test.ts replaces the whole providers module, so it
 * passes even if the real registry stopped declaring the flag or stopped
 * returning the registered instance. Only a test that goes through the real
 * registry can catch the guard silently never firing in production.
 */
import { describe, it, expect } from 'vitest';
import { buildProviderFor, getAllProviders } from '../../providers/index.js';

describe('validateCostsQuota is wired through the real registry', () => {
  it('CommandCode declares that validating a key costs a real request', () => {
    const provider = buildProviderFor('commandcode');
    expect(provider, 'commandcode must resolve through the registry').toBeDefined();
    expect(provider!.validateCostsQuota).toBe(true);
  });

  it('free-check providers still report false, so the sweep keeps checking them', () => {
    // If this flipped true, the flag would be silently disabling health checks
    // for providers that are free to probe.
    for (const platform of ['openrouter', 'groq', 'nvidia']) {
      const provider = buildProviderFor(platform);
      expect(provider, `${platform} must resolve`).toBeDefined();
      expect(provider!.validateCostsQuota, platform).toBe(false);
    }
  });

  it('the flag defaults to false for every other registered built-in', () => {
    // Walks the real registry rather than a hand-written platform list, so it
    // covers providers added later too. An accidental `true` on a cheap-to-check
    // provider would remove it from health coverage with no error anywhere; the
    // opt-in has to stay deliberate and single-purpose.
    const flagged = getAllProviders()
      .filter(p => p.validateCostsQuota)
      .map(p => p.platform);
    expect(flagged).toEqual(['commandcode']);
    expect(getAllProviders().length).toBeGreaterThan(10);
  });
});
