/**
 * The surroundings of the earnings page test (tests/bx2-u3-page.test.ts): the
 * signed-in person and the Next request context only. The page, the year
 * reading, the kept copy, the day's readings and the money rule stay real.
 */
import type { ReactNode } from "react";
import type { Store } from "@/lib/store";

/** Who is signed in, whether their role may see the numbers, and the permission each page view asked for. */
export const who: { store: Store | null; allowed: boolean; needs: unknown[] } = { store: null, allowed: true, needs: [] };

export async function cookies() {
  return { get: () => undefined };
}
export function redirect(url: string): never {
  throw Error("redirect:" + url);
}
export function notFound(): never {
  throw Error("notFound");
}
export function studioPath(store: Pick<Store, "sid">, query = "", page = ""): string {
  const parts = [store.sid ? `store=${store.sid}` : "", query].filter(Boolean);
  return `${page ? `/studio/${page}` : "/studio"}${parts.length ? `?${parts.join("&")}` : ""}`;
}
/** The studio's view: the real one counts STUDIO_PAGE_UNITS of the store's studio requests and checks the role. */
export async function studioView(_cookies: unknown, _asked: unknown, need: unknown) {
  who.needs.push(need);
  if (!who.allowed) return { ok: false as const, reason: "forbidden" as const, email: "owner@example.test", store: who.store! };
  return { ok: true as const, view: { store: who.store!, role: "owner" as const, stores: [{ store: who.store!, role: "owner" as const }], owned: 1 }, fellBack: false };
}
export function StudioHeader() {
  return null;
}
export function StudioStorePin({ children }: { children: ReactNode }) {
  return children;
}
