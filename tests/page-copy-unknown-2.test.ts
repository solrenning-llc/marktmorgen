/**
 * The consumers that COPY a page (B2, on top of #2830): an unknown answer to
 * a page read is never an empty page written somewhere else (rule 24).
 *
 *   - a store copy (lib/store-copy.ts, copyStep): a step whose source page
 *     read is unknown writes nothing of that step in the other store (no
 *     draft products, no store page, no page), answers a failure to try
 *     again, keeps its progress where it was, and the same copy, tried again
 *     once the read is known, copies the page;
 *   - a funnel's file (lib/funnel-bundle-store.ts, collectBundle): rejects,
 *     and the route answers server_error with no share, no clone written;
 *   - the demo seed (lib/demo-seed.ts, ensurePage): an unknown page read is
 *     not taken for "no page" and overwritten; the run is written down as
 *     failed (pending "run:...") and the page left as it is, and the next
 *     run with a known read brings it in line.
 *
 * Synthetic stores only; the malformed answers are made by the in-memory
 * Redis, for a GET or MGET of one store's page keys alone.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { addProduct, appendSitePages, claimHandle, createStore, ensureStatsId, setProductPage, setStripeAccount, setSubscription, storeForEmail, storeForId, storeRef, type Store } from "@/lib/store";
import { productIds } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readPage, writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { readPageFunnels, writePageFunnel } from "@/lib/page-funnel-store";
import { listShares } from "@/lib/funnel-share-store";
import { collectBundle } from "@/lib/funnel-bundle-store";
import { idFor } from "@/lib/store-copy";
import { DEMO_PRODUCT, DEMO_STORE, type SeedDeps, ensureDemoStore } from "@/lib/demo-seed";
import { HOUSE_OWNER } from "@/lib/house-store";
import { readListings } from "@/lib/catalog";
import { POST as copyRoute } from "@/app/api/store/store-copy/route";
import { POST as funnelRoute } from "@/app/api/store/funnel-share/route";
import { store as redis } from "./redis-stub";

// One store's page keys answer what `bad` says, for a lone GET or MGET of them; everything else is the store.
const original = redis.pipeline.bind(redis);
let bad: { prefix: string; reply: unknown } | null = null;
(redis as unknown as { pipeline: typeof original }).pipeline = async (cmds) => {
  const [first] = cmds;
  if (bad && cmds.length === 1 && (first[0] === "GET" || first[0] === "MGET") && String(first[1]).startsWith(bad.prefix)) {
    const reply = bad.reply;
    return first[0] === "GET" ? [reply] : [first.slice(1).map(() => reply)];
  }
  return original(cmds);
};
const raw = async (key: string) => (await original([["GET", key]]))[0];
const pagePrefix = (statsId: string) => `nl:product:page:${statsId}:`;
const MALFORMED: [string, unknown][] = [["a broken record", "{"], ["a number", 1], ["a list", ["x"]]];

const OWNER = "copy-unknown-owner@example.test";
const paid = { active: true, tier: "creator" as const, cycle: "month" as const, subscriptionId: null, customerId: null, trialEnds: 0 };
const HERO = { id: "hero0001", kind: "hero", headline: "Fictional dinners in thirty minutes", sub: "", media: "none", video: null };
const BIO = { id: "bio00001", kind: "bio", heading: "About", body: "A fictional landing page." };

redis.clear();
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.STRIPE_SECRET_KEY = "sk_test_platform_only_a_stand_in";
process.env.STRIPE_DEMO_SECRET_KEY = "sk_test_demo_only_a_stand_in";
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

const fixture = (async () => {
  await claimHandle(OWNER, "copyunknownfirst", "Fictional First", "Synthetic.");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_fixture777", true);
  await setSubscription(OWNER, paid);
  const second = await createStore(OWNER, "copyunknownsecond", "Fictional Second", "");
  if (!second.ok) throw new Error("no second store");
  await ensureStatsId(storeRef(second.store));
  await setSubscription(storeRef(second.store), paid);
  const guide = await addProduct(OWNER, "Fictional Guide", "Thirty dinners.", "19", null);
  const plain = await addProduct(OWNER, "Fictional List", "One page.", "0", null);
  if (!guide.ok || !plain.ok) throw new Error("no products");
  let first = (await storeForEmail(OWNER))!;
  await writePage(first.statsId!, guide.product.id, parsePage({ blocks: [HERO] }), first);
  await setProductPage(OWNER, guide.product.id, true);
  await appendSitePages(OWNER, [{ id: "pagepage01", slug: "start", title: "Start here", nav: true, target: "", from: 0 }]);
  first = (await storeForEmail(OWNER))!;
  await writePage(first.statsId!, siteKey("pagepage01"), parsePage({ blocks: [BIO] }), first);
  await writePageFunnel(first.statsId!, { id: "funnel0001", name: "Start funnel", slug: "start-funnel", steps: [{ kind: "page", id: "pagepage01" }, { kind: "product", id: guide.product.id }], on: true, since: 1 }, [], first);
  first = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const post = (route: typeof copyRoute, path: string) => async (body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": first.sid, cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { first, to: second.store.sid, guide: guide.product.id, copy: post(copyRoute, "store-copy"), funnel: post(funnelRoute, "funnel-share") };
})();

const COPY = "5".repeat(32);
const targetOf = async (sid: string): Promise<Store> => (await storeForId(sid))!;
const progressOf = async (sid: string) => JSON.parse(String(await raw(`nl:copy:${sid}:${COPY}`))) as { phase: string; cursor: number };

test("a copy step whose product page read is unknown writes nothing of the step, and says to try again", async () => {
  const { first, to, guide, copy } = await fixture;
  const pageId = idFor(COPY, "p", guide);
  for (const [label, reply] of MALFORMED) {
    bad = { prefix: pagePrefix(first.statsId!), reply };
    let answer;
    try { answer = await copy({ action: "step", to, copy: COPY }); }
    finally { bad = null; }
    assert.equal(answer.status, 500, label);
    assert.equal(answer.body.error, "server_error", label);
    assert.equal(answer.body.done, undefined, label);
    const target = await targetOf(to);
    assert.equal(await raw(`${pagePrefix(target.statsId!)}${pageId}`), null, `${label}: no page is written for the product`);
    assert.deepEqual(productIds(target), [], `${label}: no draft product of the step is left in the other store`);
    const progress = await progressOf(to);
    assert.deepEqual([progress.phase, progress.cursor], ["products", 0], `${label}: the copy stays before that product`);
  }
});

test("the same copy, tried again with the read known, copies the product page", async () => {
  const { first, to, guide, copy } = await fixture;
  const answer = await copy({ action: "step", to, copy: COPY });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.products, { done: 2, of: 2 });
  const target = await targetOf(to);
  const page = await readPage(target.statsId, idFor(COPY, "p", guide));
  assert.equal(page.blocks.length, 1);
  assert.equal(page.blocks[0].kind === "hero" && page.blocks[0].headline, HERO.headline);
  assert.equal((await readPage(first.statsId, guide)).blocks.length, 1, "the first store's page is as it was");
});

test("a copy step whose store page read is unknown adds no store page and writes no page, and is tried again", async () => {
  const { first, to, copy } = await fixture;
  // The forms step, known.
  assert.equal((await copy({ action: "step", to, copy: COPY })).body.phase, "pages");
  const siteId = idFor(COPY, "s", "pagepage01");
  for (const [label, reply] of MALFORMED) {
    bad = { prefix: pagePrefix(first.statsId!), reply };
    let answer;
    try { answer = await copy({ action: "step", to, copy: COPY }); }
    finally { bad = null; }
    assert.equal(answer.status, 500, label);
    assert.equal(answer.body.error, "server_error", label);
    const target = await targetOf(to);
    assert.equal(await raw(`${pagePrefix(target.statsId!)}${siteKey(siteId)}`), null, `${label}: no page is written`);
    assert.deepEqual(target.sitePages.map((p) => p.id), [], `${label}: no store page without its page is added`);
    assert.equal((await progressOf(to)).phase, "pages", `${label}: the copy stays at its pages`);
  }
  const healthy = await copy({ action: "step", to, copy: COPY });
  assert.equal(healthy.status, 200);
  const target = await targetOf(to);
  assert.deepEqual(target.sitePages.map((p) => p.id), [siteId]);
  const page = await readPage(target.statsId, siteKey(siteId));
  assert.equal(page.blocks.length, 1);
  assert.equal(page.blocks[0].kind === "bio" && page.blocks[0].body, BIO.body);
});

test("a funnel's file is never collected from an unknown page read", async () => {
  const { first, funnel } = await fixture;
  const funnelsBefore = (await readPageFunnels(first.statsId)).length;
  const pagesBefore = (await storeForEmail(OWNER))!.sitePages.length;
  for (const [label, reply] of MALFORMED) {
    bad = { prefix: pagePrefix(first.statsId!), reply };
    try {
      await assert.rejects(() => collectBundle(first, "funnel0001", "own"), label);
      const cloned = await funnel({ action: "clone", funnel: "funnel0001" });
      assert.deepEqual([cloned.status, cloned.body.error], [500, "server_error"], `${label}: a clone is refused`);
      const shared = await funnel({ action: "share", funnel: "funnel0001" });
      assert.deepEqual([shared.status, shared.body.error], [500, "server_error"], `${label}: a share is refused`);
    } finally { bad = null; }
    assert.equal((await readPageFunnels(first.statsId)).length, funnelsBefore, `${label}: no funnel is made`);
    assert.equal((await storeForEmail(OWNER))!.sitePages.length, pagesBefore, `${label}: no page is made`);
    assert.equal((await listShares(first.statsId)).length, 0, `${label}: no snapshot is shared`);
  }
});

test("a funnel's file from a known read carries the page's blocks", async () => {
  const { first, funnel } = await fixture;
  const collected = await collectBundle(first, "funnel0001", "own");
  assert.ok(collected);
  assert.match(JSON.stringify(collected.bundle), /A fictional landing page\./);
  const cloned = await funnel({ action: "clone", funnel: "funnel0001" });
  assert.equal(cloned.status, 200);
  const clone = (await storeForEmail(OWNER))!.sitePages.find((p) => p.id !== "pagepage01")!;
  assert.equal((await readPage(first.statsId, siteKey(clone.id))).blocks.some((b) => b.kind === "bio" && b.body === BIO.body), true);
});

// ---- The demo store ----------------------------------------------------------

/** A WebP's first thirty bytes, saying how big it is: all the seed reads of a picture. */
function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x49, 0x46, 0x46, 56, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0]);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  return bytes;
}
const deps: SeedDeps = {
  putFile: async () => {},
  removeFile: async () => {},
  fetchBytes: async (url) => (url.includes(DEMO_STORE.photo.id) ? webp(480, 480) : url.includes("w=800") ? webp(800, 450) : webp(1200, 675)),
};
const MARK = "nl:house:seed";
const demoPage = async () => {
  const store = (await storeForEmail(HOUSE_OWNER))!;
  const product = (await readListings(store, productIds(store))).find((p) => p.title === DEMO_PRODUCT.title)!;
  return { store, key: `${pagePrefix(store.statsId!)}${product.id}`, product };
};

test("the demo seed does not take an unknown page read for no page and overwrite it", async () => {
  await fixture;
  const made = await ensureDemoStore(deps);
  assert.deepEqual([made.ok, made.pending], [true, []]);
  const { store, key, product } = await demoPage();
  const seeded = await raw(key);
  assert.equal(typeof seeded, "string");
  // Somebody's edit of the demo page, which a known run puts back in line.
  await writePage(store.statsId!, product.id, parsePage({ blocks: [{ ...HERO, headline: "An edit to the fictional demo" }] }), store);
  const edited = await raw(key);
  for (const [label, reply] of MALFORMED) {
    await original([["DEL", MARK]]);
    bad = { prefix: pagePrefix(store.statsId!), reply };
    let run;
    try { run = await ensureDemoStore(deps); }
    finally { bad = null; }
    assert.equal(run.ran, true, label);
    assert.equal(run.pending.length, 1, label);
    assert.match(run.pending[0], /^run:/, `${label}: the run is written down as failed, to be tried again`);
    assert.equal(await raw(key), edited, `${label}: the page is left as it is`);
  }
  // A record that is not a page at all is not taken for "no page" either: it is named, not written over.
  await original([["SET", key, "{"]]);
  await original([["DEL", MARK]]);
  const broken = await ensureDemoStore(deps);
  assert.match(broken.pending[0] ?? "", /^run:/);
  assert.equal(await raw(key), "{");
  // Known again: the next run brings the page in line.
  await writePage(store.statsId!, product.id, parsePage({ blocks: [{ ...HERO, headline: "An edit to the fictional demo" }] }), store);
  await original([["DEL", MARK]]);
  const healed = await ensureDemoStore(deps);
  assert.deepEqual([healed.ok, healed.pending], [true, []]);
  assert.equal(await raw(key), seeded);
});
