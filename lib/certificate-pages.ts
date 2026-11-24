/**
 * The pages of a course's certificates in the studio (#4304): which page a request asks for, and the address of
 * another page that keeps the page's other choices. Its own module, so its rules are held by a unit test (Claude 5
 * ic5y3's LEVE 3 on #5481) rather than only by reading the page.
 */
import type { Store } from "@/lib/store";
import { studioPath } from "@/lib/studio-route";

/** The page asked for by `?certs=`: a whole number of at most six digits; anything else is the first page (0). */
export function certsPageOf(raw: unknown): number {
  return typeof raw === "string" && /^[0-9]{1,6}$/.test(raw) ? Number(raw) : 0;
}

/**
 * The address of page `to` of a course's certificates: the page's other choices kept (lesson=, work=; Claude 5 iYnra's
 * NIT 9 on #5481), the store's own `store=` written once by studioPath, `certs=` only above the first page, and the
 * certificates' heading as the anchor.
 */
export function certsHref(store: Pick<Store, "sid">, productId: string, query: Record<string, string | string[] | undefined>, to: number): string {
  const kept = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (name !== "store" && name !== "certs" && typeof value === "string") kept.set(name, value);
  if (Number.isSafeInteger(to) && to > 0) kept.set("certs", String(to));
  return `${studioPath(store, kept.toString(), `course/${productId}`)}#certificates`;
}
