import { canUseDomain } from "@/lib/domains";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";

/**
 * Whether a visit reached on a creator's own domain may be served there.
 *
 * proxy.ts says which domain a visit came in on (DOMAIN_HEADER) and what the
 * visitor asked for there (PATH_HEADER), and drops both when a visitor sends
 * them to marktmorgen.com. A store's address is served on a domain only
 * while the domain is that store's and the store is on Pro; otherwise the
 * visitor is sent to the same address on marktmorgen.com, which always
 * works.
 *
 * The store layout (app/[handle]/layout.tsx) makes this check for every
 * page. Next's layouts do not wrap route handlers, so each route under a
 * store's address that a domain also serves makes it itself, before it reads
 * or spends anything (issue #4111): offDomainRedirect for one a visitor
 * opens, offDomainNotFound for the map only that host's crawlers read, and
 * offDomainRobots for that host's crawler rules.
 */
export const DOMAIN_HEADER = "x-nimbus-domain";
/** The path and query a visitor asked for on a creator's domain, before it was rewritten. */
export const PATH_HEADER = "x-nimbus-path";

type Asked = { get(name: string): string | null };
type Gated = Pick<Store, "handle" | "domain" | "subscriptionActive" | "tier">;

/**
 * Where a visit is sent instead of being served: the same address on
 * marktmorgen.com. Null when it is served: reached on marktmorgen.com, or on
 * the store's own domain while the store is on Pro.
 */
export function offDomainTarget(store: Gated, asked: Asked): string | null {
  const reachedOn = asked.get(DOMAIN_HEADER);
  if (!reachedOn) return null;
  if (store.domain?.name === reachedOn && canUseDomain(store)) return null;
  const path = asked.get(PATH_HEADER) ?? "/";
  const own = /^\/@/.test(path) ? path : `/@${store.handle}${path === "/" || path.startsWith("/?") ? path.slice(1) : path}`;
  return `${SITE_URL}${own.startsWith("/") ? own : `/@${store.handle}`}`;
}

/** For a route a visitor opens: sent to the same address on marktmorgen.com, as the layout sends a page; null when served. */
export function offDomainRedirect(store: Gated, asked: Asked): Response | null {
  const target = offDomainTarget(store, asked);
  return target ? new Response(null, { status: 307, headers: { Location: target, "Cache-Control": "no-store" } }) : null;
}

/**
 * For a file a crawler reads for the host it asked (the domain's map and
 * rules): another host's would not count, so it is not there. Null when
 * served.
 */
export function offDomainNotFound(store: Gated, asked: Asked): Response | null {
  return offDomainTarget(store, asked) ? new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } }) : null;
}

/**
 * The rules a crawler reads for a host that does not serve the store: on a
 * creator's domain once the store is off Pro, or on a domain that is not the
 * store's. Every address there sends the visitor to the same address on
 * marktmorgen.com (offDomainRedirect, the store layout), so crawlers are told
 * in so many words that they may follow them: blocking them would keep the
 * crawler from seeing where each page went, and the domain's old addresses
 * could stay listed with nothing behind them. Until #4113's review (Claude 1;
 * Codex G and X6, LOW 2) this was a 404, which crawlers read the same way only
 * by default. Never cached: the same address on the store's own domain, on
 * Pro, gives the store's own rules. Null when served.
 */
export function offDomainRobots(store: Gated, asked: Asked): Response | null {
  return offDomainTarget(store, asked)
    ? new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } })
    : null;
}
