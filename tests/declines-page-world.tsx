/**
 * The request, the sign-in and the studio's surrounding layout for
 * tests/declines-page.test.ts. Who may open the page is decided by the real
 * role table (lib/team-roles.ts) for the permission the page asks for; the
 * page, lib/declines.ts, lib/declines-rules.ts, lib/stripe-account.ts and
 * React's rendering stay real.
 */
import type { ReactNode } from "react";
import { can, type Permission, type Role } from "@/lib/team-roles";

export const world: { role: Role; asked: Permission[] } = { role: "owner", asked: [] };
export const STORE = { sid: "dec11ae5dec11ae5dec11ae5dec11ae5", name: "Declines world", stripeAccountId: "acct_DeclinesPage" };

export async function cookies() { return { get() { return undefined; } }; }
export async function headers() { return new Headers(); }
export function redirect(url: string): never { throw new Error(`redirect:${url}`); }
export function notFound(): never { throw new Error("notFound"); }

export function studioPath(store: { sid: string }, query = "", page = ""): string {
  return `/studio${page ? `/${page}` : ""}?store=${store.sid}${query ? `&${query}` : ""}`;
}
export async function studioView(_cookies: unknown, _sid: string | undefined, permission: Permission) {
  world.asked.push(permission);
  if (!can(world.role, permission)) return { ok: false as const, reason: "forbidden" as const, store: STORE };
  return { ok: true as const, view: { store: STORE, role: world.role, stores: [STORE], owned: 1 }, fellBack: false };
}

export default function Link({ href, children, ...rest }: { href: string; children: ReactNode; className?: string }) {
  return <a href={href} {...rest}>{children}</a>;
}
export function StudioHeader() { return null; }
export function StudioStorePin({ children }: { children: ReactNode }) { return <>{children}</>; }
