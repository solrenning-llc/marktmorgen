/**
 * On first click, a first click whose window has passed no longer holds the
 * buyer: the affiliate who brought them back, inside the window, is credited.
 *
 * The cookie keeps its first click for as long as the browser keeps the cookie
 * (up to 400 days, rewritten on every click), while the store's window is
 * usually 30. attributedAffiliate gave up as soon as the first click was out of
 * its window, and fell back to the last click only when the first affiliate was
 * no longer approved. So once a buyer's first click was older than the window,
 * every later affiliate's link in that browser earned nothing, for good.
 */
import { attributedAffiliate } from "@/lib/affiliates";
import { viaCookieValue } from "@/lib/affiliate-setting";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "statsid8";
const ANA = "0123456789a1";
const BRUNO = "0123456789b2";
const DAY = 86_400;

function shop(rule: "first" | "last"): Store {
  return {
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled: true, percent: 20, days: 30, rates: {}, payday: 0, hold: 0, rule },
  } as unknown as Store;
}

const person = (id: string, code: string) => JSON.stringify({ id, email: `${code}@example.com`, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });

async function main(): Promise<void> {
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, ANA, person(ANA, "ana"), BRUNO, person(BRUNO, "bruno")],
    ["HSET", `nl:aff:${STATS}:codes`, "ana", ANA, "bruno", BRUNO],
  ]);
  const now = Math.floor(Date.now() / 1000);
  const id = async (rule: "first" | "last", via: string) => (await attributedAffiliate(shop(rule), { via, session: undefined }))?.id ?? null;

  const fresh = viaCookieValue(viaCookieValue(undefined, "ana", now - 10 * DAY), "bruno", now - DAY);
  is("inside its window the first click keeps the sale", await id("first", fresh), ANA);
  is("on last click the last link earns", await id("last", fresh), BRUNO);

  const stale = viaCookieValue(viaCookieValue(undefined, "ana", now - 41 * DAY), "bruno", now - DAY);
  is("a first click past its window leaves the sale to the link that brought the buyer back", await id("first", stale), BRUNO);
  is("on last click nothing changes", await id("last", stale), BRUNO);

  const both = viaCookieValue(viaCookieValue(undefined, "ana", now - 60 * DAY), "bruno", now - 45 * DAY);
  is("with both clicks past the window nobody is credited", await id("first", both), null);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
