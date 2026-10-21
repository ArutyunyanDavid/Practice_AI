import express from 'express';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { AppError, publicError } from './errors.js';
import { ScoreLibrary } from './library.js';
import { extractMeasureForAnalysis } from './measure.js';
import { OpenAIService } from './openai.js';
import type { OpenAIServiceOptions } from './openai.js';
import { createRateLimiter } from './rate-limit.js';

export interface AppOptions {
  scoresDirectory: string;
  cacheDirectory: string;
  distDirectory?: string;
  museScorePath?: string;
  museScoreResolver?: () => Promise<string | null>;
  openAI?: OpenAIServiceOptions;
}

function measureIndexFrom(value: string): number {
  if (!/^(0|[1-9]\d{0,5})$/.test(value)) {
    throw new AppError(400, 'INVALID_MEASURE', 'The measure reference must be a non-negative whole number.');
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index)) {
    throw new AppError(400, 'INVALID_MEASURE', 'The measure reference is outside the supported range.');
  }
  return index;
}

function pathParameter(value: string | string[], message: string): string {
  if (typeof value !== 'string') throw new AppError(400, 'INVALID_REQUEST', message);
  return value;
}

function analysisBody(value: unknown): { requestId?: string; measureLabel?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'INVALID_REQUEST', 'The analysis request body must be a JSON object.');
  }
  const body = value as Record<string, unknown>;
  let requestId: string | undefined;
  let measureLabel: string | undefined;
  if (body.requestId !== undefined) {
    if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(body.requestId)) {
      throw new AppError(400, 'INVALID_REQUEST_ID', 'The analysis request identifier is invalid.');
    }
    requestId = body.requestId;
  }
  if (body.measureLabel !== undefined) {
    if (typeof body.measureLabel !== 'string' || body.measureLabel.trim().length < 1 || body.measureLabel.length > 40) {
      throw new AppError(400, 'INVALID_MEASURE_LABEL', 'The measure label is invalid.');
    }
    // This is display-only input. The canonical label is always read from backend-owned MusicXML.
    measureLabel = body.measureLabel.trim();
  }
  return { requestId, measureLabel };
}

export function createApp(options: AppOptions) {
  const app = express();
  const library = new ScoreLibrary(options);
  const ai = new OpenAIService({
    apiKey: options.openAI?.apiKey ?? process.env.OPENAI_API_KEY,
    model: options.openAI?.model ?? process.env.OPENAI_MODEL,
    transport: options.openAI?.transport,
  });
  const testConnectionRateLimit = createRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    code: 'AI_TEST_RATE_LIMITED',
    message: 'Too many connection tests were requested. Wait a moment and try again.',
  });
  const analysisRateLimit = createRateLimiter({
    maxRequests: 6,
    windowMs: 60_000,
    code: 'ANALYSIS_RATE_LIMITED',
    message: 'Too many analyses were requested. Wait a moment before analyzing another measure.',
  });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', async (_request, response, next) => {
    try {
      await mkdir(options.scoresDirectory, { recursive: true });
      const museScorePath = await library.museScoreExecutable();
      response.json({
        ok: true,
        scoresDirectory: path.resolve(options.scoresDirectory),
        museScore: {
          available: Boolean(museScorePath),
          path: museScorePath,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/scores', async (_request, response, next) => {
    try {
      await mkdir(options.scoresDirectory, { recursive: true });
      const scores = await library.list();
      response.set('Cache-Control', 'no-store');
      response.json({ scores, scannedAt: new Date().toISOString() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/scores/:id/content', async (request, response, next) => {
    try {
      const result = await library.content(request.params.id);
      response.set({
        'Content-Type': 'application/vnd.recordare.musicxml+xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Score-Cache': result.cacheStatus,
      });
      response.send(result.xml);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/ai/status', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(ai.status());
  });

  app.post('/api/ai/test', testConnectionRateLimit, async (_request, response, next) => {
    try {
      const status = await ai.testConnection();
      response.set('Cache-Control', 'no-store');
      response.json(status);
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/api/scores/:scoreId/measures/:measureIndex/analyze',
    analysisRateLimit,
    async (request, response, next) => {
      try {
        const index = measureIndexFrom(pathParameter(request.params.measureIndex, 'The measure reference is invalid.'));
        const { requestId } = analysisBody(request.body);
        const scoreId = pathParameter(request.params.scoreId, 'The score reference is invalid.');
        const source = await library.analysisSource(scoreId);
        const measure = extractMeasureForAnalysis(source.xml, index);
        const generated = await ai.analyze({
          scoreId: source.score.id,
          scoreFilename: source.score.filename,
          scoreTitle: source.score.title,
          composer: source.score.composer,
          measure,
        });
        response.set('Cache-Control', 'no-store');
        response.json({
          ...(requestId ? { requestId } : {}),
          analysis: {
            scoreId: source.score.id,
            scoreTitle: source.score.title,
            composer: source.score.composer,
            measure: { index: measure.index, label: measure.label },
            analysis: generated.analysis,
            exercises: generated.exercises,
            model: ai.model,
            reasoningEffort: ai.reasoningEffort,
            generatedAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: { code: 'API_NOT_FOUND', message: 'That API route does not exist.' } });
  });

  if (options.distDirectory && existsSync(options.distDirectory)) {
    app.use(express.static(options.distDirectory, { index: false }));
    app.get(/.*/, (_request, response) => {
      response.sendFile(path.join(options.distDirectory!, 'index.html'));
    });
  }

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const safe = publicError(error);
    if (safe.retryAfterSeconds !== undefined) response.set('Retry-After', String(safe.retryAfterSeconds));
    response.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
  });

  return { app, library, ai };
}
