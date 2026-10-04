// The GitHub REST request helper: headers, JSON in/out, and errors that carry the status and rate limit.

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited = false,
    /** When the rate limit resets, in ms since the epoch. */
    readonly resetAt?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export type Request = (method: string, path: string, token: string, body?: unknown) => Promise<unknown>;

const utcTime = (ms: number) => new Date(ms).toISOString().slice(11, 16);

export function createRequest(apiUrl: string, fetchImpl: typeof fetch): Request {
  return async (method, path, token, body) => {
    let res: Response;
    try {
      res = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "andrun",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new GitHubError(`could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    const text = await res.text();
    if (!res.ok) throw failure(res, text);
    return text ? (JSON.parse(text) as unknown) : undefined;
  };
}

function failure(res: Response, text: string): GitHubError {
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    // not JSON: keep the raw text
  }
  const limited = (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
  if (!limited) return new GitHubError(`GitHub answered ${res.status}: ${message}`, res.status);
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const resetAt = reset > 0 ? reset * 1000 : undefined;
  const when = resetAt === undefined ? "" : ` Resets at ${utcTime(resetAt)} UTC.`;
  return new GitHubError(`GitHub answered ${res.status}: ${message} (rate limit).${when}`, res.status, true, resetAt);
}
