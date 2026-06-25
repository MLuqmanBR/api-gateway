import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

// Mock the providers module BEFORE health.ts is imported so the mocks apply
// at module-load time. The provider's behavior is controlled at runtime via
// the `validateMock` closure (hoisted so vi.mock can reach it).
const validateMock = vi.hoisted(() => ({
  returnValue: true as boolean,
  throwError: null as Error | null,
}));

vi.mock('../../providers/index.js', () => ({
  buildProviderFor: () => ({
    platform: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    validateKey: () => {
      if (validateMock.throwError) return Promise.reject(validateMock.throwError);
      return Promise.resolve(validateMock.returnValue);
    },
  }),
  hasProvider: () => true,
}));

// The api_keys rows in these tests use placeholder encrypted blobs that
// would fail real decryption. The health checker treats decrypt failure
// as a hard 'error', so we have to short-circuit it.
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/crypto.js')>('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

// Now import the health module — it picks up the mocked providers.
import {
  checkKeyHealth,
  checkAllKeys,
  resetErrorStatuses,
  markKeyHealthyFromRequest,
} from '../../services/health.js';
import { subscribe } from '../../services/events.js';
import type { KeyStatus } from '@api-gateway/shared/types.js';

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE;
  else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
}

function insertKey(platform: string, id: number, label: string, status: KeyStatus = 'unknown') {
  getDb().prepare(`
    INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, 'enc', 'iv', 'tag', ?, 1)
  `).run(id, platform, label, status);
}

function getStatus(id: number): KeyStatus | undefined {
  const row = getDb().prepare("SELECT status FROM api_keys WHERE id = ?").get(id) as { status: KeyStatus } | undefined;
  return row?.status;
}

function getLastChecked(id: number): string | null {
  const row = getDb().prepare("SELECT last_checked_at FROM api_keys WHERE id = ?").get(id) as { last_checked_at: string | null } | undefined;
  return row?.last_checked_at ?? null;
}

describe('Health checker (#256)', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    validateMock.returnValue = true;
    validateMock.throwError = null;
  });

  afterEach(() => {
    restoreEnv();
  });

  describe('checkKeyHealth — transport errors must NOT downgrade status', () => {
    it('leaves a healthy key on healthy when the validation endpoint is unreachable', async () => {
      validateMock.throwError = new Error('fetch failed');
      insertKey('nvidia', 1, 'nvidia-1', 'healthy');
      const status = await checkKeyHealth(1);
      // Status must be unchanged — transport error doesn't prove the key is bad.
      expect(status).toBe('healthy');
      expect(getStatus(1)).toBe('healthy');
      // last_checked_at MUST update so the operator sees we tried.
      expect(getLastChecked(1)).not.toBeNull();
    });

    it('leaves an unknown key on unknown when the validation endpoint is unreachable', async () => {
      validateMock.throwError = new Error('fetch failed');
      insertKey('nvidia', 2, 'nvidia-2', 'unknown');
      const status = await checkKeyHealth(2);
      expect(status).toBe('unknown');
      expect(getStatus(2)).toBe('unknown');
      expect(getLastChecked(2)).not.toBeNull();
    });

    it('leaves an error key on error (does not silently promote a stuck key)', async () => {
      // A key previously marked 'error' from an old run must NOT be promoted
      // back to 'healthy' just because the next transport error resolved
      // (i.e. nothing changed). Promotion back to healthy is the job of
      // markKeyHealthyFromRequest, called when the key actually serves a
      // request.
      validateMock.throwError = new Error('fetch failed');
      insertKey('nvidia', 3, 'nvidia-3', 'error');
      const status = await checkKeyHealth(3);
      expect(status).toBe('error');
      expect(getStatus(3)).toBe('error');
    });

    it('does NOT increment the auto-disable counter on transport errors', async () => {
      // Auto-disable (3 consecutive failures → enabled=0) is reserved for
      // confirmed 401/403. Transport errors must not contribute — that was
      // the exact bug the previous code had where DNS hiccups silently
      // disabled perfectly good keys after enough retries.
      validateMock.throwError = new Error('fetch failed');
      insertKey('nvidia', 4, 'nvidia-4', 'healthy');
      for (let i = 0; i < 5; i++) {
        await checkKeyHealth(4);
      }
      const row = getDb().prepare("SELECT enabled FROM api_keys WHERE id = 4").get() as { enabled: number };
      expect(row.enabled).toBe(1);
    });
  });

  describe('checkKeyHealth — confirmed 401/403 still mark invalid', () => {
    it('marks a key invalid when validateKey returns false', async () => {
      validateMock.returnValue = false;
      insertKey('nvidia', 5, 'nvidia-5', 'healthy');
      const status = await checkKeyHealth(5);
      expect(status).toBe('invalid');
      expect(getStatus(5)).toBe('invalid');
    });

    it('marks a key healthy when validateKey returns true', async () => {
      validateMock.returnValue = true;
      insertKey('nvidia', 6, 'nvidia-6', 'unknown');
      const status = await checkKeyHealth(6);
      expect(status).toBe('healthy');
      expect(getStatus(6)).toBe('healthy');
    });

    it('auto-disables a key after 3 consecutive confirmed 401/403 failures', async () => {
      validateMock.returnValue = false;
      insertKey('nvidia', 7, 'nvidia-7', 'healthy');
      for (let i = 0; i < 3; i++) {
        await checkKeyHealth(7);
      }
      const row = getDb().prepare("SELECT enabled FROM api_keys WHERE id = 7").get() as { enabled: number };
      expect(row.enabled).toBe(0);
    });
  });

  describe('resetErrorStatuses — startup recovery from transport-error residue', () => {
    it('flips status=error back to status=unknown on startup', () => {
      insertKey('nvidia', 8, 'nvidia-8', 'error');
      insertKey('nvidia', 9, 'nvidia-9', 'error');
      insertKey('nvidia', 10, 'nvidia-10', 'healthy');
      resetErrorStatuses();
      expect(getStatus(8)).toBe('unknown');
      expect(getStatus(9)).toBe('unknown');
      expect(getStatus(10)).toBe('healthy');
    });
  });

  describe('markKeyHealthyFromRequest — successful request promotes stuck keys', () => {
    it('promotes a key from error to healthy when it actually serves a request', () => {
      insertKey('nvidia', 11, 'nvidia-11', 'error');
      markKeyHealthyFromRequest(11);
      expect(getStatus(11)).toBe('healthy');
    });

    it('promotes a key from unknown to healthy', () => {
      insertKey('nvidia', 12, 'nvidia-12', 'unknown');
      markKeyHealthyFromRequest(12);
      expect(getStatus(12)).toBe('healthy');
    });

    it('does NOT downgrade a confirmed invalid key (the proxy will surface 401/403 again)', () => {
      insertKey('nvidia', 13, 'nvidia-13', 'invalid');
      markKeyHealthyFromRequest(13);
      expect(getStatus(13)).toBe('invalid');
    });
  });

  describe('checkAllKeys — bounded parallel + live progress events', () => {
    it('processes keys in parallel and emits per-key progress events', async () => {
      validateMock.returnValue = true;
      // Insert 5 keys. With parallel processing, all 5 should resolve
      // near-instantly. The signal that the sequential loop is gone is
      // the wall-time assertion below.
      for (let i = 0; i < 5; i++) {
        insertKey('nvidia', 100 + i, `nvidia-${i}`, 'unknown');
      }
      const published: Array<{ type: string; total?: number; completed?: number; status?: string }> = [];
      const unsub = subscribe((e) => {
        if (e.type.startsWith('health.check')) published.push(e as any);
      });

      try {
        const t0 = Date.now();
        await checkAllKeys();
        const elapsed = Date.now() - t0;
        // Generous upper bound — if it ran sequentially, even with mocked
        // providers, the loop overhead + promise scheduling would push
        // past 2s easily on 5 keys. The whole batch should be
        // near-instant here.
        expect(elapsed).toBeLessThan(2000);

        // We expect exactly one 'start' event, one 'done' event, and one
        // 'progress' event per key.
        const startEvents = published.filter((e) => e.type === 'health.check.start');
        const doneEvents = published.filter((e) => e.type === 'health.check.done');
        const progressEvents = published.filter((e) => e.type === 'health.check.progress');
        expect(startEvents).toHaveLength(1);
        expect(doneEvents).toHaveLength(1);
        expect(progressEvents).toHaveLength(5);
        expect(startEvents[0].total).toBe(5);
        expect(doneEvents[0].total).toBe(5);
        // Each progress event must have a valid status + the running counter.
        for (const p of progressEvents) {
          expect(p.status).toBe('healthy');
          expect(p.completed).toBeGreaterThanOrEqual(1);
          expect(p.completed).toBeLessThanOrEqual(5);
          expect(p.total).toBe(5);
        }
        // The progress events' completed counter must end at total.
        const last = progressEvents[progressEvents.length - 1];
        expect(last.completed).toBe(5);
      } finally {
        unsub();
      }
    });
  });
});
