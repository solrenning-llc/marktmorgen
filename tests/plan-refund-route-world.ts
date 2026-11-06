import { type Store } from "@/lib/store";
/** The signed-in creator of the plan refund route test (tests/plan-refund-route.test.ts): the store and role set by the test. */
export const who: { store: Store | null; role: "owner" | "admin" | "editor" | "support" } = { store: null, role: "owner" };
export async function creatorFrom() {
  return { email: who.store!.email, ref: who.store!.email, store: who.store!, role: who.role, origin: "https://local.example", studio: (query = "") => `/studio?${query}` };
}
export function away(origin: string, path: string) {
  return Response.redirect(new URL(path, origin), 303);
}
export function studioPath(store: Pick<Store, "sid">, query = "", page = ""): string {
  const parts = [store.sid ? `store=${store.sid}` : "", query].filter(Boolean);
  return `${page ? `/studio/${page}` : "/studio"}${parts.length ? `?${parts.join("&")}` : ""}`;
}
/** The review page's view of the same creator (tests/plan-refund-page.test.ts). */
export async function studioView() {
  return { ok: true as const, view: { store: who.store!, role: who.role, stores: [who.store!], owned: [who.store!] }, fellBack: false };
}
