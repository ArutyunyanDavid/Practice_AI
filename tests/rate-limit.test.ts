import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createRateLimiter } from '../server/rate-limit.js';

function invoke(limiter: RequestHandler, ip: string): unknown {
  let nextValue: unknown;
  const request = { ip, socket: { remoteAddress: ip } } as unknown as Request;
  limiter(
    request,
    {} as Response,
    ((value?: unknown) => {
      nextValue = value;
    }) as NextFunction,
  );
  return nextValue;
}

describe('in-memory API rate limiter', () => {
  it('bounds active client history while retaining the most recently seen clients', () => {
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      code: 'TEST_RATE_LIMITED',
      message: 'Too many test requests.',
    });

    for (let index = 0; index <= 10_000; index += 1) {
      expect(invoke(limiter, `client-${index}`)).toBeUndefined();
    }

    expect(invoke(limiter, 'client-10000')).toMatchObject({
      status: 429,
      code: 'TEST_RATE_LIMITED',
    });
    expect(invoke(limiter, 'client-0')).toBeUndefined();
  });
});
