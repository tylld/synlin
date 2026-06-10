/**
 * User-facing error carrying a process exit code.
 * Exit codes: 0 success, 1 unexpected error, 2 user/validation error.
 */
export class SynlinError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'SynlinError';
    this.exitCode = exitCode;
  }
}

export function isSynlinError(error: unknown): error is SynlinError {
  return error instanceof SynlinError;
}
