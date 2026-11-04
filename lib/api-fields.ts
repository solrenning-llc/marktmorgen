/**
 * Choosing the fields of an API answer (630 [HN6](42), as 255 [WH4] and 616
 * [WP15](21) foresaw): `?fields=email,agreed` keeps only those fields of each
 * object in `data`, in the order the answer writes them, so a tool reads
 * less and a page of a list stays small. Only the top level of each object
 * is chosen; the paging fields beside `data` (`next`, `total`, …) are always
 * kept. A field no object in the answer has is refused by name, so a typo
 * never comes back as a quietly empty answer. Without `fields`, the answer
 * is exactly as before.
 */
import { apiError, apiOk } from "@/lib/api-guard";

export const MAX_FIELDS_ASKED = 30;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The fields asked for, null when none; or the name that cannot be a field. */
export function fieldsAsked(url: string): { ok: true; fields: string[] | null } | { ok: false; bad: string } {
  const raw = new URL(url).searchParams.get("fields");
  if (raw === null) return { ok: true, fields: null };
  const names = [...new Set(raw.split(",").map((n) => n.trim()).filter(Boolean))];
  if (!names.length) return { ok: false, bad: "" };
  if (names.length > MAX_FIELDS_ASKED) return { ok: false, bad: names[MAX_FIELDS_ASKED] };
  const bad = names.find((n) => !NAME.test(n));
  return bad !== undefined ? { ok: false, bad } : { ok: true, fields: names };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The answer with only the chosen fields in `data`'s objects; or the first chosen field none of them has. */
export function pickFields(body: unknown, fields: string[] | null): { ok: true; body: unknown } | { ok: false; unknown: string } {
  if (!fields || !isObject(body) || !("data" in body)) return { ok: true, body };
  const items = Array.isArray(body.data) ? body.data : [body.data];
  const objects = items.filter(isObject);
  if (objects.length) {
    const missing = fields.find((f) => !objects.some((o) => Object.hasOwn(o, f)));
    if (missing) return { ok: false, unknown: missing };
  }
  const keep = (o: unknown) => (isObject(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => fields.includes(k))) : o);
  return { ok: true, body: { ...body, data: Array.isArray(body.data) ? body.data.map(keep) : keep(body.data) } };
}

/**
 * The 400 for a `?fields=` that cannot be read, or null when it can (or none
 * was sent). A reading that takes more than its request checks this before it
 * takes or reads anything, so a mistyped field costs only the request.
 */
export function badFields(request: Request): Response | null {
  const asked = fieldsAsked(request.url);
  if (asked.ok) return null;
  return apiError(400, "fields", asked.bad ? `“${asked.bad}” cannot be a field name. Use letters, digits and underscores, at most ${MAX_FIELDS_ASKED} fields.` : "Name at least one field, separated by commas.");
}

/** apiOk with `?fields=` applied, or the 400 that names the field. */
export function apiOkFields(request: Request, body: unknown): Response {
  const bad = badFields(request);
  if (bad) return bad;
  const asked = fieldsAsked(request.url);
  const picked = pickFields(body, asked.ok ? asked.fields : null);
  if (!picked.ok) return apiError(400, "unknown_field", `No item in this answer has a field named “${picked.unknown}”.`);
  return apiOk(picked.body);
}
