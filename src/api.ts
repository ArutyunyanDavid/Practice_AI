import type {
  AiConnectionStatus,
  AnalysisResponse,
  ApiErrorBody,
  HealthStatus,
  ScoreSummary,
  SelectedMeasure,
} from './types';

const STANDARD_TIMEOUT_MS = 15_000;
const ANALYSIS_TIMEOUT_MS = 630_000;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfter?: string | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = STANDARD_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort(init.signal?.reason);

  if (init.signal?.aborted) {
    forwardAbort();
  } else {
    init.signal?.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new ApiRequestError(
        'The request timed out. Please check the server connection and try again.',
        504,
        'CLIENT_TIMEOUT',
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener('abort', forwardAbort);
  }
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  let body: (T & ApiErrorBody) | undefined;
  try {
    body = await response.json() as T & ApiErrorBody;
  } catch {
    // A status-based message below remains useful when a proxy returns non-JSON.
  }
  if (!response.ok) {
    throw new ApiRequestError(
      body?.error?.message ?? `Request failed (${response.status}).`,
      response.status,
      body?.error?.code,
      response.headers.get('Retry-After'),
    );
  }
  if (!body) {
    throw new ApiRequestError('The server returned an unreadable response.', response.status, 'INVALID_RESPONSE');
  }
  return body;
}

export async function fetchScores(signal?: AbortSignal): Promise<{ scores: ScoreSummary[]; scannedAt: string }> {
  const response = await fetchWithTimeout('/api/scores', { signal, cache: 'no-store' });
  return jsonOrThrow(response);
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthStatus> {
  const response = await fetchWithTimeout('/api/health', { signal, cache: 'no-store' });
  return jsonOrThrow(response);
}

export async function fetchScoreXml(scoreId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchWithTimeout(`/api/scores/${encodeURIComponent(scoreId)}/content`, {
    signal,
    cache: 'no-store',
  }, 150_000);
  if (!response.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = await response.json() as ApiErrorBody;
    } catch {
      // The generic status message below still gives the user a useful error.
    }
    throw new ApiRequestError(
      body?.error?.message ?? `The score could not be opened (${response.status}).`,
      response.status,
      body?.error?.code,
      response.headers.get('Retry-After'),
    );
  }
  return response.text();
}

export async function fetchAiStatus(signal?: AbortSignal): Promise<AiConnectionStatus> {
  const response = await fetchWithTimeout('/api/ai/status', {
    signal,
    cache: 'no-store',
  });
  return jsonOrThrow(response);
}

export async function testAiConnection(signal?: AbortSignal): Promise<AiConnectionStatus> {
  const response = await fetchWithTimeout('/api/ai/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
    cache: 'no-store',
  }, 105_000);
  return jsonOrThrow(response);
}

export async function analyzeMeasure(
  scoreId: string,
  measure: SelectedMeasure,
  requestId: string,
  signal?: AbortSignal,
  previousAnalysisId?: string,
): Promise<AnalysisResponse> {
  const response = await fetchWithTimeout(
    `/api/scores/${encodeURIComponent(scoreId)}/measures/${measure.index}/analyze`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The backend derives the canonical printed label from trusted MusicXML.
      body: JSON.stringify({ requestId, previousAnalysisId }),
      signal,
      cache: 'no-store',
    },
    ANALYSIS_TIMEOUT_MS,
  );
  return jsonOrThrow(response);
}
