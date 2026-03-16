// ─── Shared Utilities ───

/**
 * C-21: fetch with configurable timeout via AbortController.
 * Prevents hanging requests from blocking the pipeline.
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

/**
 * NC-23 / shared: Round to 3 decimal places.
 */
export function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
