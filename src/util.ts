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
