import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { initDb, getDb } from '../../db/index.js';
import { startRequestRetentionPruner, stopRequestRetentionPruner } from '../../services/request-retention.js';
import { attachClientAbort } from '../../lib/abort.js';

// Process-survival contracts: background timers and client-disconnect stream
// errors must never escalate into a fatal uncaughtException.
describe('crash safety', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    stopRequestRetentionPruner();
    vi.useRealTimers();
  });

  it('retention pruner interval swallows a failing DB instead of crashing the process', () => {
    vi.useFakeTimers();
    startRequestRetentionPruner();
    // Sabotage: closing the handle makes every subsequent prepare() throw.
    getDb().close();
    expect(() => vi.advanceTimersByTime(3 * 10 * 60 * 1000)).not.toThrow();
  });

  it('response stream "error" event after client disconnect does not escape attachClientAbort', () => {
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const { controller, detach } = attachClientAbort(res as never);
    // A reset socket surfaces as 'error' AFTER the route's try/catch is gone;
    // without the registered listener Node would raise an uncaughtException.
    expect(() => res.emit('error', Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow();
    res.emit('close');
    expect(controller.signal.aborted).toBe(true);
    detach();
  });

  it('clean completion close does not abort', () => {
    const res = Object.assign(new EventEmitter(), { writableEnded: true });
    const { controller, detach } = attachClientAbort(res as never);
    res.emit('close');
    expect(controller.signal.aborted).toBe(false);
    detach();
  });
});
