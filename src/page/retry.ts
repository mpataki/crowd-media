export const MAX_RETRIES = 3;
export const BACKOFF_BASE_MS = 500;

/** Status 0 stands for a network failure (fetch rejected). */
export function isRetryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Delay before the next attempt after `failures` consecutive failures (1-based), or
 * null to give up: 500 ms, 1 s, 2 s, then stop. Non-retryable statuses stop at once.
 */
export function retryDelay(failures: number, status: number): number | null {
  if (!isRetryable(status) || failures > MAX_RETRIES) return null;
  return BACKOFF_BASE_MS * 2 ** (failures - 1);
}
