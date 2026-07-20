import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { setRetryAfter } from '../../lib/http-headers.js';

describe('C8: setRetryAfter helper', () => {
  it('sets Retry-After header with ceiling seconds', () => {
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
    } as unknown as Response;
    setRetryAfter(mockRes, 2.1);
    expect(headers['Retry-After']).toBe('3');
  });

  it('enforces minimum 1 second', () => {
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
    } as unknown as Response;
    setRetryAfter(mockRes, 0);
    expect(headers['Retry-After']).toBe('1');
  });

  it('handles fractional timeout → ceil', () => {
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
    } as unknown as Response;
    setRetryAfter(mockRes, 0.1);
    expect(headers['Retry-After']).toBe('1');
  });

  it('handles large values', () => {
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
    } as unknown as Response;
    setRetryAfter(mockRes, 120);
    expect(headers['Retry-After']).toBe('120');
  });
});
