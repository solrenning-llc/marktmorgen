/** A passkey prompt or redirect requires an explicit successful HTTP response. */
export type PasskeyAnswer =
  | { ok: true; options: Record<string, unknown>; next?: never }
  | { ok: true; next: "/studio"; options?: never }
  | { ok: false; error: string };

const ERRORS = new Set(["not_recognised", "rate_limited", "unavailable", "busy", "server_error"]);

export function passkeyAnswer(httpOK: boolean, raw: unknown, action: "options" | "verify"): PasskeyAnswer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "server_error" };
  const value = raw as Record<string, unknown>;
  if (value.ok === false && typeof value.error === "string" && ERRORS.has(value.error)) {
    return { ok: false, error: value.error };
  }
  if (!httpOK || value.ok !== true || value.error !== undefined) return { ok: false, error: "server_error" };
  if (action === "options") {
    if (!value.options || typeof value.options !== "object" || Array.isArray(value.options)) return { ok: false, error: "server_error" };
    return { ok: true, options: value.options as Record<string, unknown> };
  }
  // The sign-in route has one destination. Never navigate to an arbitrary response URL.
  if (value.next !== undefined && value.next !== "/studio") return { ok: false, error: "server_error" };
  return { ok: true, next: "/studio" };
}
