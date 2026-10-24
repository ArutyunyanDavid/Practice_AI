import type { RequestHandler } from 'express';
import { AppError } from './errors.js';

interface RateLimitOptions {
  maxRequests: number;
  windowMs: number;
  code: string;
  message: string;
}

const MAX_TRACKED_CLIENTS = 10_000;
const RETAINED_CLIENTS_AFTER_PRUNE = 8_000;

function pruneClientHistory(requestsByClient: Map<string, number[]>, threshold: number): void {
  for (const [client, timestamps] of requestsByClient) {
    if (timestamps.every((timestamp) => timestamp <= threshold)) requestsByClient.delete(client);
  }

  if (requestsByClient.size <= MAX_TRACKED_CLIENTS) return;
  const clientsToRemove = requestsByClient.size - RETAINED_CLIENTS_AFTER_PRUNE;
  let removed = 0;
  for (const client of requestsByClient.keys()) {
    requestsByClient.delete(client);
    removed += 1;
    if (removed >= clientsToRemove) break;
  }
}

/** A small in-memory limiter intended for a single server process. */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const requestsByClient = new Map<string, number[]>();

  return (request, _response, next) => {
    const now = Date.now();
    const threshold = now - options.windowMs;
    const client = request.ip || request.socket.remoteAddress || 'unknown';
    const recent = (requestsByClient.get(client) ?? []).filter((timestamp) => timestamp > threshold);

    if (recent.length >= options.maxRequests) {
      requestsByClient.delete(client);
      requestsByClient.set(client, recent);
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + options.windowMs - now) / 1_000));
      next(new AppError(429, options.code, options.message, { retryAfterSeconds }));
      return;
    }

    recent.push(now);
    // Refresh insertion order so emergency pruning discards least-recently-seen clients.
    requestsByClient.delete(client);
    requestsByClient.set(client, recent);

    // Bound memory if a public deployment receives requests from many one-off addresses.
    if (requestsByClient.size > MAX_TRACKED_CLIENTS) pruneClientHistory(requestsByClient, threshold);
    next();
  };
}
