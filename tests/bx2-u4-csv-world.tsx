/**
 * The surroundings of the earnings file test (tests/bx2-u4-csv.test.ts): the
 * signed-in person, the studio's count of requests and the Next request
 * context only. The route, the page, the year reading, the kept copy, the
 * day's readings, the money rule and the file stay real.
 */
import type { ReactNode } from "react";
import type { Store } from "@/lib/store";

/**
 * Who is signed in, whether their role may see the numbers, the permission
 * each request asked for, the studio units each extra count took, and whether
 * the store's studio figure is used.
 */
export const who: { store: Store | null; allowed: boolean; needs: unknown[]; units: number[]; used: boolean } = {
  store: null,
  allowed: true,
  needs: [],
  units: [],
  used: false,
};

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
/**
 * A route's creator: the real one checks the role and takes one studio
 * request (lib/studio-route.ts, studioAccess: countStudio(access.store, need),
 * one unit), or answers with where to go instead.
 */
export async function creatorFrom(_request: unknown, need: unknown) {
  who.needs.push(need);
  if (!who.allowed) return new Response("forbidden", { status: 403 });
  return { store: who.store!, role: "owner" as const, email: "owner@example.test", origin: "https://marktmorgen.test", studio: () => "/studio" };
}
/** More studio requests taken: refused when the figure is used, as the real one answers. */
export async function countStudio(_store: unknown, _need: unknown, units = 1) {
  if (who.used) return { ok: false as const, reason: "used" as const, message: "Your studio requests for this month are used." };
  who.units.push(units);
  return { ok: true as const };
}
export function StudioHeader() {
  return null;
}
export function StudioStorePin({ children }: { children: ReactNode }) {
  return children;
}
