/** What the requests to speech services share: the Authorization header, and readable errors without the key. */

export const bearer = (key?: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

/** The message of the service behind a router, which OpenRouter carries as JSON text in `metadata.raw`. */
function relayed(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const message = (JSON.parse(raw) as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" && message ? message : raw;
  } catch {
    return raw;
  }
}

/** The message of an error reply in the shapes these services use, else its text; never the key. */
export function errorText(body: string, key?: string): string {
  let text = body;
  try {
    const j = JSON.parse(body) as { error?: unknown; detail?: unknown; message?: unknown };
    const e = j.error;
    const found =
      typeof e === "string"
        ? e
        : e && typeof e === "object"
          ? (relayed((e as { metadata?: { raw?: unknown } }).metadata?.raw) ?? (e as { message?: unknown }).message)
          : (j.detail ?? j.message);
    if (typeof found === "string" && found) text = found;
  } catch {
    /* not JSON: the text as is */
  }
  if (key) text = text.split(key).join("[key]");
  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

export function failure(title: string, status: number, body: string, key?: string): Error {
  const text = errorText(body, key);
  if (status === 401 || status === 403) {
    return new Error(`${title} rejected the API key (HTTP ${status})${text ? `: ${text}` : ""}`);
  }
  return new Error(`${title} HTTP ${status}${text ? `: ${text}` : ""}`);
}
