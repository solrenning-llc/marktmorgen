/**
 * Two public reads that grow with the store, paid for before they read
 * (4 November 2026, lib/public-read-rules.ts), against the in-memory Redis
 * double, a stubbed Stripe and synthetic stores only:
 *
 *   - an affiliate's own page (app/[handle]/affiliates) counts its book with
 *     eight commands, takes affiliatePageUnits of the window's requests at
 *     once, and refused reads nothing of the book; somebody not signed in is
 *     a page that rests with the others;
 *   - the store's map (app/[handle]/store-sitemap) counts its posts with one
 *     command and takes sitemapUnits before reading a listing or a post;
 *     refused, it reads nothing and tells the crawler to come back;
 *   - what each then reads stays inside what was paid for.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { type Affiliate, bookSize, readBook } from "@/lib/affiliates";
import { admitAffiliatePage, affiliatePageCost } from "@/lib/affiliate-page-admission";
import { affiliatePageUnits, sitemapUnits } from "@/lib/public-read-rules";
import { paidStoreSitemap, sitemapSize, storeSitemap } from "@/lib/store-sitemap";
import { savePost } from "@/lib/store-blog";
import { requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { AFFILIATE_FIELD_BYTES, AFFILIATE_PAGE_COMMANDS, AFFILIATE_ROW_BYTES, AFFILIATE_STRIPE_CALLS, PUBLIC_LISTING_BYTES, TAKE_COMMANDS, affiliatePageRead } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

process.env.STRIPE_SECRET_KEY = "sk_test_public_reads_only";
const NOW = Math.floor(Date.now() / 1000);
let stripeCalls = 0;
globalThis.fetch = (async () => {
  stripeCalls += 1;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

/** Every command sent while `run` runs, and the bytes of the replies. */
async function watched<T>(run: () => Promise<T>): Promise<{ value: T; names: string[]; bytes: number; taken: number }> {
  const original = redis.pipeline;
  const names: string[] = [];
  let bytes = 0;
  let taken = 0;
  try {
    redis.pipeline = async (commands) => {
      for (const c of commands) {
        names.push(String(c[0]));
        if (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) taken += Number(c[2]);
      }
      const replies = await original.call(redis, commands);
      bytes += JSON.stringify(replies ?? null).length;
      return replies;
    };
    const value = await run();
    return { value, names, bytes, taken };
  } finally {
    redis.pipeline = original;
  }
}

const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" });
const sale = (ref: string, aff: string) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at: NOW - 3600, product: "prod01", title: "Bread course", base: 2000, total: 2000, currency: "usd", rate: 30, self: false, how: "click" });

async function paidStore(owner: string, handle: string) {
  await claimHandle(owner, handle, `${handle} shop`, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, `acct_1Test${handle.padEnd(8, "x").slice(0, 8)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();

  part("An affiliate's own page");
  const OWNER = "aff-owner@example.com";
  let shop = await paidStore(OWNER, "breadshop");
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId!;
  const ANA = "aaaaaaaaaaaa";
  const people: (string | number)[] = [];
  for (let i = 0; i < 40; i += 1) {
    const id = i === 0 ? ANA : i.toString(16).padStart(12, "b");
    people.push(id, person(id, `p${i}@example.com`, `code${i}`));
  }
  const sales: (string | number)[] = [];
  for (let i = 0; i < 300; i += 1) sales.push(`ref${i}`, sale(`ref${i}`, i % 3 === 0 ? ANA : "1".padStart(12, "b")));
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ...people],
    ["HSET", `nl:aff:${statsId}:sales`, ...sales],
    ["HSET", `nl:aff:${statsId}:clicks`, ANA, 90],
  ]);
  const ana = { share: null } as Pick<Affiliate, "share">;

  const counted = await watched(() => bookSize(shop));
  is("the book is counted with eight commands, none of which reads a record", [counted.names.length, counted.names.every((n) => n === "HLEN" || n === "ZCARD")], [8, true]);
  is("its size: every field of the program's records", counted.value, { fields: 40 + 300 + 1, rows: 0 });
  const units = affiliatePageUnits({ ...counted.value!, listings: 0 });
  is("and what the page will take for it", await affiliatePageCost(shop, ana), units);

  const admitted = await watched(() => admitAffiliatePage(shop, ana));
  is("admitted with room in the window", admitted.value, true);
  is(`the page took ${units} requests at once, the size it reads`, admitted.taken, units);
  is("and read nothing of the book to decide", admitted.names.includes("HGETALL"), false);

  stripeCalls = 0;
  const read = await watched(() => readBook(shop, ANA));
  is("the book it then reads is the affiliate's own", read.value.rows.map((r) => r.affiliate.id), [ANA]);
  const size = { ...counted.value!, listings: 0 };
  is(`its commands (${read.names.length}) stay inside what was priced`, read.names.length <= AFFILIATE_PAGE_COMMANDS + TAKE_COMMANDS + size.rows, true);
  is(`its bytes (${read.bytes}) stay inside what was priced`, read.bytes <= size.fields * AFFILIATE_FIELD_BYTES + size.rows * AFFILIATE_ROW_BYTES, true);
  is(`its calls to Stripe (${stripeCalls}) stay inside what was priced`, stripeCalls <= AFFILIATE_STRIPE_CALLS, true);
  is("and the requests taken cost more than all of it", units * laterPageCost() >= affiliatePageRead(size), true);

  part("A refused affiliate page reads nothing");
  await takePublicRequest(shop, "buyer", Date.now(), requestLimitFor(shop));
  is("the window used up", await takePublicRequest(shop, "buyer", Date.now(), 1), false);
  const refused = await watched(() => admitAffiliatePage(shop, ana));
  is("refused", refused.value, false);
  is("not one record of the program read", refused.names.filter((n) => n !== "HLEN" && n !== "ZCARD" && n !== "INCRBY" && n !== "HINCRBY" && n !== "EXPIRE" && n !== "GET" && n !== "HGET"), []);
  is("no HGETALL at all", refused.names.includes("HGETALL"), false);
  const visitor = await watched(() => admitAffiliatePage(shop, null));
  is("somebody not signed in: the page rests with the store's others", [visitor.value, visitor.names.includes("HGETALL")], [false, false]);
  const page = readFileSync("app/[handle]/affiliates/page.tsx", "utf8");
  const gate = page.indexOf("if (!(await admitAffiliatePage(store, affiliate))) return <StoreResting store={store} buyer={affiliate !== null} />;");
  is("the page asks before it reads the book, the listings or the codes, and rests when refused", [gate > 0, gate < page.indexOf("await readBook("), gate < page.indexOf("await readListings("), gate < page.indexOf("await codeOwners(")], [true, true, true, true]);

  part("The store's map");
  const MAP = "map-owner@example.com";
  let mapShop = await paidStore(MAP, "mapshop");
  for (let i = 0; i < 3; i += 1) await addProduct(MAP, `Guide ${i}`, "", "19", null);
  mapShop = (await storeForEmail(MAP))!;
  let n = 0;
  const nextId = () => (n++).toString(16).padStart(10, "0");
  for (let i = 0; i < 14; i += 1) await savePost(mapShop.statsId, null, { title: `Post ${i}`, body: "Words.", product: null, draft: false }, nextId, ROOM, 1_000 + i);

  const mapSize = await watched(() => sitemapSize(mapShop));
  is("counted with one command", mapSize.names, ["ZCARD"]);
  is("its size: the visible products and two pages of posts", mapSize.value, { listings: 3, postPages: 2 });
  const want = await storeSitemap(mapShop);
  const drawn = await watched(() => paidStoreSitemap(mapShop));
  is("the same map as before, every product, the blog and its posts", drawn.value, want);
  is(`it took ${sitemapUnits(mapSize.value!)} requests first, the size it reads`, drawn.taken, sitemapUnits(mapSize.value!));
  is("and read no more pages of posts than were paid for", drawn.names.filter((c) => c === "ZREVRANGE").length <= mapSize.value!.postPages, true);
  is(`its bytes (${drawn.bytes}) stay inside what was priced`, drawn.bytes <= mapSize.value!.listings * PUBLIC_LISTING_BYTES + mapSize.value!.postPages * 12 * 2_048 + 4_096, true);

  part("A refused map reads nothing");
  await takePublicRequest(mapShop, "buyer", Date.now(), requestLimitFor(mapShop));
  is("the window used up", await takePublicRequest(mapShop, "buyer", Date.now(), 1), false);
  const none = await watched(() => paidStoreSitemap(mapShop));
  is("refused", none.value, null);
  is("no listing and no post read", ["MGET", "ZREVRANGE", "HMGET", "GET"].some((c) => none.names.includes(c)), false);
  const route = readFileSync("app/[handle]/store-sitemap/route.ts", "utf8");
  is("the route answers a refusal with 503 and Retry-After, kept by no cache", [route.includes("paidStoreSitemap(store)"), route.includes('status: 503, headers: { "Retry-After": "3600", "Cache-Control": "no-store"')], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
