/**
 * Minimal structural shape of a non-2xx `fetch` response we can safely describe. Kept structural (rather
 * than `Response`) so it works with the browser fetch response without extra typings and is trivial to
 * exercise from tests.
 *
 * This mirrors the sidecar daemon's `describeNegotiateFailure` (src/sidecar/negotiate-error.ts): both
 * negotiate paths surface the server's error body instead of an opaque status. They are intentionally kept
 * as small parallel helpers because the edge SDK is a standalone package that does not import from `src/`.
 */
export interface NegotiateErrorResponse {
  readonly status: number;
  text(): Promise<string>;
}

const MAX_DETAIL_LENGTH = 500;

/**
 * Redact credential-bearing query parameters that could appear if an upstream ever echoed a runtime
 * connection URL back in an error body. We never want a token in a thrown error message or log line.
 */
const SECRET_QUERY_PATTERN = /([?&](?:access_token|token|sig|signature|awstoken|key|secret|password)=)[^&\s"']+/gi;

/**
 * Build a sanitized, bounded description of a failed worker negotiate response in the form
 * `HTTP <status>: <server detail>`. It surfaces central's structured `{ error }` message (or the raw body
 * when the response is not JSON) so the browser worker can report *why* registration was rejected instead
 * of only an opaque status code. The request URL is never included and any token-like query value in the
 * body is redacted.
 */
export async function describeNegotiateFailure(response: NegotiateErrorResponse): Promise<string> {
  const detail = await readSanitizedDetail(response);
  return detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`;
}

async function readSanitizedDetail(response: NegotiateErrorResponse): Promise<string> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return '';
  }
  let detail = raw.trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const message = (parsed as Record<string, unknown>).error;
      if (typeof message === 'string' && message.trim().length > 0) {
        detail = message.trim();
      }
    }
  } catch {
    // Body is not JSON; keep the trimmed raw text as the detail.
  }
  detail = detail.replace(SECRET_QUERY_PATTERN, '$1[redacted]');
  return detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH)}…` : detail;
}
