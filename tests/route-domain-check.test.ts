/**
 * The routes under a store's address that a creator's own domain also serves
 * (issue #4111): the funnel link (go/[funnel]), a certificate's file
 * (certificate/[id]/pdf), the business card file (contact/vcard) and the
 * store's map and crawler rules (store-sitemap, store-robots, answered there
 * as /sitemap.xml and /robots.txt). Next's layouts do not wrap route
 * handlers, so each one makes the store layout's own check itself, through
 * the same helper (lib/domain-gate.ts). What is checked:
 *
 *   - reached on a domain that is not the store's, or on its own domain once
 *     the store is off Pro, a route answers the way the layout does: the
 *     funnel, the certificate and the card send the visitor to the same
 *     address on marktmorgen.com; the map and the rules, which a crawler
 *     reads for that host only, are not there (404), never cached;
 *   - nothing is written or paid for before that answer;
 *   - on the store's own proven domain, on Pro, each is served as before;
 *   - on marktmorgen.com nothing changes, and the store's map there does not
 *     carry the domain headers a visitor sent (proxy.ts);
 *   - the layout answers exactly as before.
 */
import { createElement } from "react";
import { NextRequest } from "next/server";
import StoreLayout from "@/app/[handle]/layout";
import { GET as goRoute } from "@/app/[handle]/go/[funnel]/route";
import { GET as certificateRoute } from "@/app/[handle]/certificate/[id]/pdf/route";
import { GET as vcardRoute } from "@/app/[handle]/contact/vcard/route";
import { GET as sitemapRoute } from "@/app/[handle]/store-sitemap/route";
import { GET as robotsRoute } from "@/app/[handle]/store-robots/route";
import { type CreatorCard, saveCreatorCard } from "@/lib/creator-card";
import { SITE_URL } from "@/lib/site-url";
import { claimHandle, ensureStatsId, ensureStoreId, setDomain, setSubscription, storeForEmail } from "@/lib/store";
import { proxy } from "@/proxy";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const PRO_OWNER = "routes-pro@example.com";
const LOST_OWNER = "routes-lost@example.com";
const PRO_DOMAIN = "shop.example.com";
const LOST_DOMAIN = "lost.example.com";
const CERT = "a1b2c3d4e5f6a7b8";

/** A request as the proxy hands it on after a creator's domain was reached (proxy.ts). */
function asked(url: string, reachedOn: string | null, path: string): NextRequest {
  const headers = new Headers();
  if (reachedOn) {
    headers.set("x-nimbus-domain", reachedOn);
    headers.set("x-nimbus-path", path);
  }
  return new NextRequest(url, { headers });
}

type Seen = { status: number; location: string | null; cache: string | null };
const seen = (response: Response): Seen => ({ status: response.status, location: response.headers.get("location"), cache: response.headers.get("cache-control") });

/** Commands that change something in Redis: a public request taken, a mark written. */
const WRITES = /^(SET|SETEX|SETNX|INCR|INCRBY|DECR|DECRBY|HSET|HINCRBY|HDEL|EXPIRE|PEXPIRE|EVAL|EVALSHA|DEL|ZADD|ZREM|SADD|SREM|LPUSH|RPUSH|LTRIM)$/i;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const card: CreatorCard = { on: true, name: "Route Tester", title: "Creator", email: "card@example.com", phone: "", website: "", note: "" };
  for (const [owner, handle, tier, domain] of [
    [PRO_OWNER, "proshop", "pro", PRO_DOMAIN],
    [LOST_OWNER, "lostshop", "creator", LOST_DOMAIN],
  ] as const) {
    await claimHandle(owner, handle, "Route Shop", "");
    await ensureStatsId(owner);
    await ensureStoreId(owner);
    await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier, period: paidPeriod() });
    await setDomain(owner, { name: domain, addedAt: "2026-10-01", liveAt: "2026-10-02" });
    const store = (await storeForEmail(owner))!;
    await saveCreatorCard(store.statsId!, card, store);
  }

  const routes = (handle: string, host: string, reachedOn: string | null) => {
    const base = reachedOn ? `https://${host}` : `https://${host}/@${handle}`;
    const params = <T extends object>(more: T) => ({ params: Promise.resolve({ handle: `@${handle}`, ...more }) });
    return {
      go: async () => seen(await goRoute(asked(`${base}/go/launch?utm_source=x`, reachedOn, "/go/launch?utm_source=x"), params({ funnel: "launch" }))),
      certificate: async () => seen(await certificateRoute(asked(`${base}/certificate/${CERT}/pdf`, reachedOn, `/certificate/${CERT}/pdf`), params({ id: CERT }))),
      vcard: async () => seen(await vcardRoute(asked(`${base}/contact/vcard`, reachedOn, "/contact/vcard"), params({}))),
      sitemap: async () => seen(await sitemapRoute(asked(`${base}/sitemap.xml`, reachedOn, "/sitemap.xml"), params({}))),
      robots: async () => seen(await robotsRoute(asked(`${base}/robots.txt`, reachedOn, "/robots.txt"), params({}))),
    };
  };

  const away = (path: string): Seen => ({ status: 307, location: `${SITE_URL}${path}`, cache: "no-store" });
  const gone: Seen = { status: 404, location: null, cache: "no-store" };

  part("Off Pro, reached on its own domain: the layout's answer, nothing written or paid");
  const lost = routes("lostshop", LOST_DOMAIN, LOST_DOMAIN);
  const written: string[] = [];
  const run = redis.run.bind(redis);
  redis.run = (command) => {
    if (WRITES.test(String(command[0]))) written.push(`${command[0]} ${command[1]}`);
    return run(command);
  };
  try {
    is("the funnel link goes to the same address on marktmorgen.com, with what it carried", await lost.go(), away("/@lostshop/go/launch?utm_source=x"));
    is("the certificate's file too", await lost.certificate(), away(`/@lostshop/certificate/${CERT}/pdf`));
    is("the card's file too", await lost.vcard(), away("/@lostshop/contact/vcard"));
    is("the map is not there for that host, and no cache keeps the answer", await lost.sitemap(), gone);
    is("nor are the rules", await lost.robots(), gone);
  } finally {
    redis.run = run;
  }
  is("no public request spent and nothing written on the way", written, []);

  part("On Pro, reached on a domain that is not its own");
  const stranger = routes("proshop", "other.example.com", "other.example.com");
  is("the funnel link is sent to marktmorgen.com", await stranger.go(), away("/@proshop/go/launch?utm_source=x"));
  is("the certificate's file too", await stranger.certificate(), away(`/@proshop/certificate/${CERT}/pdf`));
  is("the card's file too", await stranger.vcard(), away("/@proshop/contact/vcard"));
  is("the map is not there", await stranger.sitemap(), gone);
  is("nor are the rules", await stranger.robots(), gone);

  part("On Pro, reached on its own proven domain: served as before");
  const own = routes("proshop", PRO_DOMAIN, PRO_DOMAIN);
  is("the funnel link, with no such funnel, goes to the store on the domain", await own.go(), { status: 307, location: `https://${PRO_DOMAIN}/@proshop`, cache: "no-store" });
  is("a certificate that does not exist is not found, as before", (await own.certificate()).status, 404);
  is("the card's file is given", (await own.vcard()).status, 200);
  is("the map is given", (await own.sitemap()).status, 200);
  is("the rules are given", (await own.robots()).status, 200);

  part("On marktmorgen.com: nothing changes, Pro or not");
  const home = routes("lostshop", "marktmorgen.com", null);
  is("the funnel link, with no such funnel, goes to the store", await home.go(), { status: 307, location: "https://marktmorgen.com/@lostshop", cache: "no-store" });
  is("a certificate that does not exist is not found", (await home.certificate()).status, 404);
  is("the card's file is given", (await home.vcard()).status, 200);
  is("the map is given", (await home.sitemap()).status, 200);
  is("the rules are given", (await home.robots()).status, 200);
  const spoofed = await proxy(new NextRequest("https://marktmorgen.com/@lostshop/sitemap.xml", { headers: { "x-nimbus-domain": LOST_DOMAIN, "x-nimbus-path": "/x" } }));
  const passed = (spoofed.headers.get("x-middleware-override-headers") ?? "").split(",");
  is("the store's map here is reached with the request's headers rewritten", spoofed.headers.has("x-middleware-override-headers"), true);
  is("and without the domain headers a visitor sent", [passed.includes("x-nimbus-domain"), passed.includes("x-nimbus-path")], [false, false]);
  is("still served from the store's map", spoofed.headers.get("x-middleware-rewrite"), "https://marktmorgen.com/@lostshop/store-sitemap");

  part("The layout answers as before");
  const layout = async (handle: string, reachedOn: string | null, path: string): Promise<string> => {
    answering(asked(reachedOn ? `https://${reachedOn}${path}` : `https://marktmorgen.com/@${handle}`, reachedOn, path));
    try {
      await StoreLayout({ children: createElement("div", null, "PAGE"), params: Promise.resolve({ handle: `@${handle}` }) } as never);
      return "drawn";
    } catch (error) {
      const digest = (error as { digest?: string }).digest ?? "";
      if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2] ?? "";
      throw error;
    } finally {
      answering(null);
    }
  };
  is("off Pro on its own domain: sent to the same page here", await layout("lostshop", LOST_DOMAIN, "/about"), `${SITE_URL}/@lostshop/about`);
  is("its front page: to the store here", await layout("lostshop", LOST_DOMAIN, "/"), `${SITE_URL}/@lostshop`);
  is("its long address on the domain: kept as it is", await layout("lostshop", LOST_DOMAIN, "/@lostshop/p/x"), `${SITE_URL}/@lostshop/p/x`);
  is("on Pro on another domain: sent here", await layout("proshop", "other.example.com", "/?a=1"), `${SITE_URL}/@proshop?a=1`);
  is("on Pro on its own domain: drawn", await layout("proshop", PRO_DOMAIN, "/about"), "drawn");
  is("on marktmorgen.com: drawn", await layout("lostshop", null, "/"), "drawn");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
