export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: ErrorOptions & { retryAfterSeconds?: number },
  ) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export function publicError(error: unknown): {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }

  console.error(error);
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong while processing the score.',
  };
}
