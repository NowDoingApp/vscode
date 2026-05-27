export function parseJson<T>(value: string): T | undefined {
  if (!value.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function errorMessageFromResponse(status: number, body: string): string {
  const parsed = parseJson<{ error?: string }>(body);
  if (parsed?.error) {
    return `HTTP ${status}: ${parsed.error}`;
  }
  return `HTTP ${status}`;
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function buildActivitySearchPath(
  basePath: string,
  query: string,
  limit: number
): string {
  const q = encodeURIComponent(query);
  return `${basePath}?q=${q}&limit=${limit}`;
}

export interface WatchIgnorePatternEvaluation {
  isIgnored: boolean;
  invalidPattern: boolean;
}

export function evaluateWatchIgnorePattern(
  pattern: string,
  branch: string
): WatchIgnorePatternEvaluation {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return { isIgnored: false, invalidPattern: false };
  }

  try {
    const regex = new RegExp(trimmed);
    return {
      isIgnored: regex.test(branch),
      invalidPattern: false,
    };
  } catch {
    return { isIgnored: false, invalidPattern: true };
  }
}

export function getRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const delay = 1000 * 2 ** (safeAttempt - 1);
  return Math.min(delay, 30000);
}

export function isRetryableNotifyError(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return (
    message.includes("http 429") ||
    message.includes("http 503") ||
    message.includes("timeout") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("ehostunreach") ||
    message.includes("enetunreach")
  );
}
