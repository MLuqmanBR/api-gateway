/**
 * F9: Request queueing + per-provider concurrency caps.
 *
 * Per-platform counting semaphore with a bounded FIFO waiter queue.
 * When a provider is at max concurrency, new requests wait up to
 * `queue_timeout_ms` for a slot. On timeout, the caller gets a 503
 * (D-FEATURES-6 = reject-503 — client retries, no failover to worse model).
 *
 * Ships `reject` + `fifo` only; `priority` strategy deferred.
 *
 * Attribution: semaphore + FIFO pattern from LimitlessLLM (MIT).
 */

import { getSetting } from '../db/index.js';
import { parseIntSetting } from '../lib/settings-parse.js';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: QueueTimeoutError) => void;
  timer: ReturnType<typeof setTimeout>;
  enqueuedAt: number;
}

class ProviderSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly platform: string,
    private readonly maxConcurrency: number,
    private readonly maxQueueSize: number,
    private readonly timeoutMs: number,
  ) {}

  async acquire(): Promise<() => void> {
    // Fast path: slot available
    if (this.maxConcurrency <= 0 || this.active < this.maxConcurrency) {
      this.active++;
      return () => this.release();
    }

    // Queue full → immediate 503 (reject strategy)
    if (this.waiters.length >= this.maxQueueSize) {
      throw new QueueTimeoutError(this.platform, this.timeoutMs, 'queue_full');
    }

    // FIFO wait with timeout
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (release) => {
          clearTimeout(waiter.timer);
          resolve(release);
        },
        reject: (err) => {
          clearTimeout(waiter.timer);
          reject(err);
        },
        timer: setTimeout(() => {
          // Remove from queue and reject
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new QueueTimeoutError(this.platform, this.timeoutMs, 'timeout'));
        }, this.timeoutMs),
        enqueuedAt: Date.now(),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active--;
    // Wake the head of the FIFO queue
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (this.active < this.maxConcurrency) {
        this.active++;
        next.resolve(() => this.release());
        return;
      }
      // No slot — put it back at the front and stop
      this.waiters.unshift(next);
      break;
    }
  }

  stats() {
    return { platform: this.platform, active: this.active, queued: this.waiters.length };
  }
}

export class QueueTimeoutError extends Error {
  constructor(
    public readonly platform: string,
    public readonly timeoutMs: number,
    public readonly reason: 'queue_full' | 'timeout',
  ) {
    super(`Concurrency queue ${reason} for ${platform} after ${timeoutMs}ms`);
    this.name = 'QueueTimeoutError';
  }
}

const semaphores = new Map<string, ProviderSemaphore>();

// H19: settings may change at runtime — a semaphore's cached limits go
// stale until restart. Track the settings fingerprint each semaphore was
// built with and rebuild when the relevant settings changed.
let lastSemaphoreFingerprint = '';

function queueSettingsFingerprint(): string {
  return [
    getSetting('max_concurrency_per_provider') ?? '0',
    getSetting('max_queue_size') ?? '100',
    getSetting('queue_timeout_ms') ?? '2000',
  ].join('|');
}

function getSemaphore(platform: string): ProviderSemaphore {
  const fingerprint = queueSettingsFingerprint();
  if (fingerprint !== lastSemaphoreFingerprint) {
    // Config changed: drop the old semaphores (in-flight releases still
    // work — the release closure holds its own semaphore reference) so new
    // acquires use the current limits.
    semaphores.clear();
    lastSemaphoreFingerprint = fingerprint;
  }
  let sem = semaphores.get(platform);
  if (!sem) {
    // M20: NaN-safe — parseInt on a corrupt setting previously yielded NaN,
    // making the concurrency cap check (`acquired < NaN`) false for every
    // acquire and effectively disabling the queue limits.
    const maxConcurrency = parseIntSetting('max_concurrency_per_provider', 0);
    const maxQueueSize = parseIntSetting('max_queue_size', 100);
    const timeoutMs = parseIntSetting('queue_timeout_ms', 2000);
    sem = new ProviderSemaphore(platform, maxConcurrency, maxQueueSize, timeoutMs);
    semaphores.set(platform, sem);
  }
  return sem;
}

/** Acquire a concurrency slot for the given platform. Returns a release
 * function. Throws QueueTimeoutError if no slot within the timeout. */
export async function acquireSlot(platform: string): Promise<() => void> {
  return getSemaphore(platform).acquire();
}

/** Check if concurrency caps are enabled (max_concurrency_per_provider > 0). */
export function isQueueEnabled(): boolean {
  return parseIntSetting('max_concurrency_per_provider', 0) > 0;
}

/** Get queue stats for all providers (for /api/queue admin route). */
export function getQueueStats() {
  return [...semaphores.values()].map(s => s.stats());
}

/** Reset all semaphores (for tests). */
export function resetSemaphores(): void {
  semaphores.clear();
}
