import type { RequestHandler } from 'express';
import { AppError } from './errors.js';

interface RateLimitOptions {
  maxRequests: number;
  windowMs: number;
  code: string;
  message: string;
}

/** A small in-memory limiter intended for this single-process local application. */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const requestsByClient = new Map<string, number[]>();

  return (request, _response, next) => {
    const now = Date.now();
    const threshold = now - options.windowMs;
    const client = request.ip || request.socket.remoteAddress || 'unknown';
    const recent = (requestsByClient.get(client) ?? []).filter((timestamp) => timestamp > threshold);

    if (recent.length >= options.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + options.windowMs - now) / 1_000));
      next(new AppError(429, options.code, options.message, { retryAfterSeconds }));
      return;
    }

    recent.push(now);
    requestsByClient.set(client, recent);

    // Bound memory if a public deployment receives requests from many one-off addresses.
    if (requestsByClient.size > 10_000) {
      for (const [key, timestamps] of requestsByClient) {
        if (timestamps.every((timestamp) => timestamp <= threshold)) requestsByClient.delete(key);
        if (requestsByClient.size <= 8_000) break;
      }
    }
    next();
  };
}
