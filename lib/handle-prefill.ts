/**
 * The store address typed on the home page, carried to the address step
 * (VS1, WCAG 3.3.7 Redundant Entry), so a creator never types it twice.
 *
 * It travels only in addresses: the home form's GET to /signin, the request
 * for the login link, the link in that email, the one-tap confirm page and
 * the redirect to the studio. Logging in with Google carries it, for ten
 * minutes, in that login's own cookie (lib/google-signin.ts), since Google's
 * page takes nothing of ours along. Nothing here stores it, in the browser
 * or on the server, and nothing reserves it: the address is taken only by the
 * address step's own form (components/handle-form.tsx) through
 * app/api/store/claim, under the same rules as any other address, and
 * somebody may have taken it in the meantime.
 *
 * At every step it is read again from untrusted input with the store's own
 * handle rules; anything that is not a valid store address is dropped, and
 * the step simply opens empty, as it always did.
 */
import { newAddressProblem, normaliseHandle } from "@/lib/store";

/** Longer input than this is never a handle and is not even looked at. */
const MAX_RAW = 64;

/** The valid store address in `raw`, normalised, or "" for anything else. */
export function prefillHandle(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW) return "";
  const handle = normaliseHandle(raw);
  return handle && newAddressProblem(handle) === null ? handle : "";
}

/** `path` with `handle=` added when `raw` holds a valid store address; `path` unchanged otherwise. */
export function withPrefill(path: string, raw: unknown): string {
  const handle = prefillHandle(raw);
  if (!handle) return path;
  return `${path}${path.includes("?") ? "&" : "?"}handle=${encodeURIComponent(handle)}`;
}
