/**
 * A store closing, end to end (added 18 October 2026), against whichever
 * Redis "@/lib/redis" is built with: the in-memory one in
 * tests/closed-store.test.ts, a real one in scripts/test_closed_store_redis.py.
 * The file store is an in-memory stand-in in both: never the real bucket.
 *
 * Two stores: one that closes, one that stays, sharing a buyer. The closing
 * one has every key family of the registry: what its own code writes (people
 * in every part of it, tests/erasure-world.ts), a key of every family the
 * walk erases named by its ids, members naming it in every list of the
 * company's, keys of the families gone by themselves, and the records found
 * only through its own (stop links, certificates, short links, shares,
 * broadcasts, PayPal orders, calendar tokens, call packages, gift and
 * pre-order records under their payment). The other store has the same
 * keys under its own ids. Then the first one's plan ends, its three notices
 * go out, its day comes, and the walk runs. What must be true after:
 *
 *   - in the file store, nothing of it: nothing is copied anywhere, its
 *     sales stay on its own Stripe account;
 *   - in the database, no key or value naming it but the company's records
 *     the registry declares, and keys of families gone by themselves within
 *     the days CLOSING declares, each with its expiry set: what each sale
 *     left under its own reference, and its id in the shared buyer's
 *     library, which points at nothing;
 *   - the other store exactly as it was, the shared buyer's library showing
 *     it alone, every company list keeping its members;
 *   - its memberships held from the day its plan ended (not charged, queue
 *     item 307 EC1) and ended at once on its day, its owner told three
 *     times, and its buyer told once, at least seven days before its day;
 *   - every key it made under a name no longer than the cost registry prices
 *     a name at (tests/plan-cost-registry.ts, KEY_NAME_BYTES).
 */
import { createHash } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { CLOSING, closingFamilyOf, closingOf as ruleOf } from "@/lib/data-families";
import { claimHandle, setProductFile, setSubscription, storeFolder, storeForEmail, storeForId, storeRef } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { memberStores } from "@/lib/team";
import { normaliseEmail } from "@/lib/auth";
import { closeEnded, closeOne, finishClosed, type Hands } from "@/lib/plan-closing";
import { CLOSING_DAYS, WARN_MONTH_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { eraseClosed } from "@/lib/closed-store-data";
import { storesKnownFor } from "@/lib/buyer-library";
import { rememberAffiliate } from "@/lib/affiliate-hub";
import { putMember } from "@/lib/team";
import { claimsKey, hostId } from "@/lib/host-claims";
import { hostCalendarKeys } from "@/lib/host-calendar";
import { previewKey } from "@/lib/pdf-preview";
import { copyKey, problemKey } from "@/lib/pdf-stamp";
import { giftKeys } from "@/lib/gifts";
import { piKey as preorderPiKey } from "@/lib/preorders";
import { subKey as adsSubKey } from "@/lib/ad-events";
import { movedKey } from "@/lib/call-records";
import { confirmedKey } from "@/lib/calls";
import { doneKey as shippedKey } from "@/lib/shipments";
import { certKey, allKey as certificatesKey } from "@/lib/certificate";
import { linkKey as shortLinkKey } from "@/lib/short-links";
import { lookupKey as shareLookupKey } from "@/lib/funnel-share-store";
import { broadcastKeys } from "@/lib/broadcasts";
import { paypalOrderKeys } from "@/lib/paypal-sales";
import { calendarKeys } from "@/lib/calendar-sync";
import { packageKeys, packagesKey } from "@/lib/call-packages";
import { linkKey as pitchStopKey } from "@/lib/outreach";
import { vaultPath } from "@/lib/vault-rules";
import type { ProductFile } from "@/lib/product-file";
import { type World, makeWorld, seedPerson, snapshot } from "./erasure-world";
import { ROOM } from "./data-room";
import { KEY_NAME_BYTES } from "./plan-cost-registry";

export type Check = (what: string, got: unknown, want: unknown) => void;
export type Sent = { to: string; subject: string; text: string };

const DAY = 86_400_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const CLOSER = "closer@example.com";
const KEEPER = "keeper@example.com";

/** What the stand-ins for Stripe answer, and what they were asked to change. */
export type StripeWorld = { sessions: Record<string, unknown>[]; memberships: Record<string, unknown>[]; posted: { path: string; body: string; account: string }[] };

/**
 * The network as the journey sees it: Stripe and the email sender stood in
 * for, anything else either passed to `passThrough` (the real Redis's REST
 * proxy) or refused.
 */
export function standIns(stripe: StripeWorld, sent: Sent[], passThrough: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | null): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.hostname === "api.resend.com") {
      type One = { to: string | string[]; subject: string; text?: string };
      const body = JSON.parse(String(init?.body)) as One | One[];
      for (const m of Array.isArray(body) ? body : [body]) sent.push({ to: [m.to].flat()[0], subject: m.subject, text: m.text ?? "" });
      return json(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: `email_${sent.length}` });
    }
    if (url.hostname === "api.stripe.com") {
      const headers = new Headers(init?.headers);
      const account = headers.get("stripe-account") ?? "";
      const path = url.pathname.replace(/^\/v1/, "");
      const method = init?.method ?? "GET";
      if (method === "POST") {
        stripe.posted.push({ path, body: String(init?.body ?? ""), account });
        return json({ id: path.split("/").pop(), object: "subscription", cancel_at_period_end: true });
      }
      if (method === "DELETE") {
        stripe.posted.push({ path, body: "DELETE", account });
        return json({ id: path.split("/").pop(), object: "subscription", status: "canceled" });
      }
      if (path === "/checkout/sessions" && account) {
        const since = Number(url.searchParams.get("created[gte]") ?? 0), until = Number(url.searchParams.get("created[lt]") ?? Infinity);
        return json({ object: "list", data: stripe.sessions.filter((s) => s.account === account && Number(s.created) >= since && Number(s.created) < until), has_more: false });
      }
      if (path === "/payment_intents/search") return json({ object: "search_result", data: [], has_more: false, next_page: null });
      if (path === "/subscriptions/search" && account) {
        const query = url.searchParams.get("query") ?? "";
        return json({ object: "search_result", data: stripe.memberships.filter((m) => m.account === account && query.includes(`'${(m.metadata as { store: string }).store}'`)), has_more: false, next_page: null });
      }
      if (path === "/subscriptions/search" || path === "/subscriptions") return json({ object: "list", data: [], has_more: false });
      // A member's invoices (queue item 307 EC1, the hold): none open, none paid in this journey.
      if (path === "/invoices" && account) return json({ object: "list", data: [], has_more: false });
      const one = stripe.memberships.find((m) => m.account === account && path === `/subscriptions/${String(m.id)}`);
      if (one) return json(one);
      return json({ error: { message: `no stand-in for ${method} ${path}`, type: "invalid_request_error" } }, 404);
    }
    if (url.hostname.endsWith("vercel-storage.com") || url.hostname.endsWith("vercel.com")) return json({ blobs: [], hasMore: false });
    if (passThrough) return passThrough(input, init);
    throw new Error(`no network in this journey: ${url.hostname}`);
  }) as typeof fetch;
}

/** The ids a store's keys and values carry, by which what is left of it is found. */
function marksOf(world: World, folder: string): string[] {
  const s = world.store;
  return [s.sid, s.statsId, s.listId, s.callsId, world.communityId, folder, world.courseId, s.stripeAccountId, storeRef(s)].filter((m): m is string => typeof m === "string" && m.length >= 8);
}

/** Puts a key of the type a family keeps, so a list the walk prunes is the type it really is. */
async function addMember(key: string, member: string): Promise<void> {
  const [type] = await redisPipeline([["TYPE", key]]);
  const kind = String(typeof type === "string" ? type : (type as { ok?: string } | null)?.ok ?? "none");
  if (kind === "zset") await redisPipeline([["ZADD", key, 1, member]]);
  else if (kind === "hash") await redisPipeline([["HSET", key, member, "1"]]);
  else if (kind === "list") await redisPipeline([["RPUSH", key, member]]);
  else await redisPipeline([["SADD", key, member]]);
}

/**
 * A key of every family a store's closing touches, for one store: what the
 * walk erases, named by its ids; a member naming it in every company list; a
 * key of every family gone by itself, with its expiry; and a company record
 * naming it, which is kept.
 */
async function everyFamily(world: World, tag: string): Promise<void> {
  const s = world.store;
  for (const [prefix, rule] of Object.entries(CLOSING)) {
    if (prefix.includes("*") || prefix.includes("YYYY") || prefix.endsWith("{")) continue;
    if (rule.how === "erase") {
      const key = rule.by === "handle" ? `${prefix}${s.handle}` : `${prefix}${s.statsId}:probe-${tag}`;
      await redisPipeline([["SET", key, JSON.stringify({ s: s.statsId, probe: tag })]]);
    } else if (rule.how === "index" && prefix !== "nl:plan:ended") {
      // (The stores whose plan ended are read by the daily job as stores: a probe there would be looked at as one.)
      // Member holds, final closings and billing-coverage holds are sorted sets; generic indexes may be sets.
      if (prefix === "nl:closing:held" || prefix === "nl:closing:final" || prefix === "nl:held:stores") await redisPipeline([["ZADD", prefix, 1, `${s.sid}|probe-${tag}`]]);
      else await addMember(prefix.endsWith(":") ? `${prefix}2026-11` : prefix, `${s.sid}|probe-${tag}`);
    } else if (rule.how === "expires") {
      await redisPipeline([["SET", `${prefix}${sha(`${prefix}${tag}`).slice(0, 32)}`, JSON.stringify({ s: s.statsId }), "EX", Math.min(rule.days, 2) * 86_400]]);
    }
  }
  await redisPipeline([["SET", `nl:free:in:2026-11:${s.sid}`, "1", "EX", 62 * 86_400]]);
}

/** The records found only through the store's own: each kind, as its module keeps it. */
async function reachedThroughRecords(world: World, tag: string, pdf: ProductFile): Promise<string[]> {
  const s = world.store;
  const statsId = s.statsId as string;
  const id = (what: string) => sha(`${tag}:${what}`);
  const made: string[] = [];
  const put = async (key: string, value: string) => {
    await redisPipeline([["SET", key, value]]);
    made.push(key);
  };
  // A certificate, a short link, a share link, a broadcast, a PayPal order, a calendar's token and feed, a call package, a pitch's stop link.
  const cert = `cert${id("cert").slice(0, 20)}`;
  await redisPipeline([["SADD", certificatesKey(world.courseId), cert]]);
  await put(certKey(cert), JSON.stringify({ id: cert, s: statsId }));
  const code = `go${id("slink").slice(0, 8)}`;
  await redisPipeline([["HSET", `nl:slink:store:${statsId}`, code, JSON.stringify({ code })]]);
  await put(shortLinkKey(code), JSON.stringify({ s: statsId, to: "https://example.com" }));
  const share = id("share").slice(0, 40);
  await redisPipeline([["HSET", `nl:fshares:${statsId}`, `share${tag}`, JSON.stringify({ id: `share${tag}`, hash: share })]]);
  await put(shareLookupKey(share), JSON.stringify({ s: statsId }));
  const broadcast = `bc${id("bc").slice(0, 14)}`;
  await redisPipeline([["LPUSH", `nl:mail:bcs:${s.listId}`, broadcast]]);
  for (const key of broadcastKeys(broadcast)) await put(key, JSON.stringify({ list: s.listId }));
  const order = `PAYPAL${id("pp").slice(0, 14).toUpperCase()}`;
  await redisPipeline([["ZADD", `nl:ppsell:sales:${statsId}`, Math.floor(Date.now() / 1000) - 5 * 86_400, order]]);
  for (const key of paypalOrderKeys(order)) await put(key, JSON.stringify({ store: statsId, order, capture: `CAP${tag}`, email: "paypal-buyer@example.com", product: "p", cents: 900, currency: "usd", at: Math.floor(Date.now() / 1000) - 5 * 86_400 }));
  const calendar = { handle: s.handle, feeds: [{ id: id("feed").slice(0, 16), url: "https://calendar.example.com/a.ics", addedAt: new Date().toISOString() }], token: id("caltok").slice(0, 40), tokenAt: new Date().toISOString() };
  await redisPipeline([["SET", `nl:cal:cfg:${statsId}`, JSON.stringify(calendar)]]);
  for (const key of calendarKeys(calendar)) await put(key, statsId);
  const checkout = `cs_test_${id("pkg").slice(0, 24)}`;
  const packageToken = id("pkgtok").slice(0, 48);
  await redisPipeline([["SADD", packagesKey(statsId), checkout]]);
  const [record, , tokenKey] = packageKeys(checkout, packageToken);
  await put(record, JSON.stringify({ s: statsId, h: s.handle, p: "call", e: "tess.taylor@example.com", total: 3, at: 1, until: 0, token: packageToken, holds: [] }));
  await put(tokenKey, checkout);
  const stop = id("pitch").slice(0, 40);
  await redisPipeline([["HSET", `nl:outreach:${statsId}:pitches`, `pitch${tag}`, JSON.stringify({ id: `pitch${tag}`, stop })]]);
  await put(pitchStopKey(stop), JSON.stringify({ s: statsId }));
  // A PDF's preview and problem note, named by the file.
  await put(previewKey(pdf, 3), JSON.stringify({ pathname: pdf.pathname }));
  await put(problemKey(pdf.pathname), "too_big");
  return made;
}

/** The days a family's keys that name no store are kept at the most, as CLOSING declares them. */
function keptDays(key: string, terminalSale = false): number {
  // Only the terminal sources seeded below have this deadline; pending
  // physical mail is a company obligation with no expiration.
  if (terminalSale && key.startsWith("nl:ship:done:")) return 400;
  const rule = ruleOf(key);
  return rule?.how === "expires" || rule?.how === "lapses" ? rule.days : rule && "rest" in rule ? rule.rest ?? 0 : 0;
}

/** A sale on the store's Stripe account, and what it left here under its own references, each kept no longer than its family declares. */
async function soldThrough(world: World, stripe: StripeWorld, tag: string, pdf: ProductFile, at: number): Promise<string[]> {
  const s = world.store;
  const session = `cs_test_${sha(`${tag}:session`).slice(0, 30)}`;
  const pi = `pi_${sha(`${tag}:pi`).slice(0, 24)}`;
  const gift = `gift${sha(`${tag}:gift`).slice(0, 16)}`;
  const sub = `sub_${sha(`${tag}:sub`).slice(0, 20)}`;
  stripe.sessions.push({ id: session, account: s.stripeAccountId, object: "checkout.session", status: "complete", payment_status: "paid", created: Math.floor(at / 1000), amount_total: 4_900, currency: "usd", payment_intent: pi, subscription: sub, customer_details: { email: "tess.taylor@example.com", name: "Tess Taylor", address: { country: "US" } }, total_details: { amount_tax: 0, amount_discount: 0 }, metadata: { store: s.handle, product: world.plain, gift } });
  stripe.memberships.push({ id: sub, account: s.stripeAccountId, status: "active", cancel_at_period_end: false, metadata: { store: s.handle } });
  const keys = [...giftKeys(gift, pi), preorderPiKey(pi), adsSubKey(sub), shippedKey(session), movedKey(session), confirmedKey(session), copyKey(session, pdf), copyKey(pi, pdf)];
  // This fixture represents a terminal physical source. Pending sources have no TTL.
  for (const key of keys) await redisPipeline([["SET", key, JSON.stringify({ s: s.sid, e: "tess.taylor@example.com" }), "EX", Math.min(300, keptDays(key, true)) * 86_400]]);
  return keys;
}

/** A PDF on the store's plain product, kept in a stand-in file store. */
async function pdfOn(world: World, files: Map<string, number>): Promise<ProductFile> {
  const folder = await storeFolder(storeRef(world.store));
  const pathname = vaultPath(folder, world.plain, "0123456789abcdef", "guide.pdf");
  const file: ProductFile = { pathname, name: "guide.pdf", bytes: 1_000, contentType: "application/pdf", addedAt: "2026-10-01T00:00:00.000Z" };
  files.set(pathname, 1_000);
  const set = await setProductFile(storeRef(world.store), world.plain, file);
  if (!set.ok) throw new Error(`no file: ${JSON.stringify(set)}`);
  // As the store keeps it: the day it was added is the store's.
  const listing = await readListing((await storeForEmail(storeRef(world.store)))!, world.plain);
  return listing?.file ?? file;
}

export async function runClosingJourney(is: Check, sent: Sent[], stripe: StripeWorld): Promise<void> {
  // A synthetic company address: without one the buyers' notice is not sent and the store does not close (lib/company-postal.ts).
  process.env.COMPANY_POSTAL_ADDRESS = "100 Example Street, Example City, NY 10001, United States";
  const files = new Map<string, number>();
  const hands: Hands = {
    measure: async (folder) => [...files].filter(([path]) => path.startsWith(`vault/${folder}/`)).reduce((sum, [, n]) => sum + n, 0),
    list: async (prefix) => [...files.keys()].filter((path) => path.startsWith(prefix)),
    remove: async (paths) => {
      for (const path of paths) files.delete(path);
    },
  };

  // ---------------------------------------------------------------- the store that stays, first
  const tess = normaliseEmail("Tess.Taylor@Example.com");
  const keep = await makeWorld("keep-shop", KEEPER);
  await seedPerson(keep, "dan@example.com", null);
  await seedPerson(keep, tess, "dan@example.com");
  const extras = async (world: World) => {
    world.store = (await storeForEmail(storeRef(world.store)))!;
    await putMember(world.store, "helper@example.com", "editor");
    await rememberAffiliate(world.store.sid, `partner-${world.store.handle}@example.com`);
    await redisPipeline([["HSET", `nl:aff:${world.store.statsId}:emails`, `partner-${world.store.handle}@example.com`, "aff001"]]);
    await redisPipeline([["HSET", claimsKey(hostId(storeRef(world.store))), `k${sha(world.store.sid).slice(0, 24)}`, `1|2|${Date.now() + DAY}|${world.store.callsId ?? world.store.sid}:${world.plain}`]]);
    await redisPipeline([["SET", hostCalendarKeys(hostId(storeRef(world.store)))[0], JSON.stringify({ email: storeRef(world.store) })]]);
  };
  await extras(keep);
  const keepingPdf = await pdfOn(keep, files);
  keep.store = (await storeForEmail(KEEPER))!;
  const keepFolder = await storeFolder(KEEPER);
  await everyFamily(keep, "keeping");
  const [heldIndexType] = await redisPipeline([["TYPE", "nl:held:stores"]]);
  is("the billing-coverage index fixture uses the sorted-set type its actual reader requires", heldIndexType, "zset");
  const reachedKeeping = await reachedThroughRecords(keep, "keeping", keepingPdf);
  const ended = Date.UTC(2026, 10, 2, 12, 0, 0);
  const soldKeeping = await soldThrough(keep, stripe, "keeping", keepingPdf, ended - 5 * DAY);
  const alone = await snapshot();

  // ---------------------------------------------------------------- then the one that closes, sharing a buyer and a helper
  const close = await makeWorld("closing-shop", CLOSER);
  await seedPerson(close, "carol@example.com", null);
  await seedPerson(close, tess, "carol@example.com");
  await extras(close);
  const closingPdf = await pdfOn(close, files);
  close.store = (await storeForEmail(CLOSER))!;
  const closeFolder = await storeFolder(CLOSER);
  await everyFamily(close, "closing");
  const reachedClosing = await reachedThroughRecords(close, "closing", closingPdf);
  const soldClosing = [
    ...(await soldThrough(close, stripe, "closing-before", closingPdf, ended - 5 * DAY)),
    ...(await soldThrough(close, stripe, "closing-after", closingPdf, ended + 3 * DAY)),
  ];

  const closingMarks = [...marksOf(close, closeFolder), close.store.catalog?.id ?? ""].filter(Boolean);
  const before = await snapshot();
  /** The tests' own data room (tests/data-room.ts), which both stores' seeding is charged to: no store's. */
  const fixture = (key: string) => key === `nl:data:${ROOM.sid}`;
  const isNew = (key: string) => !alone.has(key) && !fixture(key);
  const touched = [...before.keys()].filter((key) => alone.has(key) && alone.get(key) !== before.get(key) && !fixture(key));
  const ofClosing = [...before.keys()].filter(isNew);
  const families = new Set(ofClosing.map((key) => closingFamilyOf(key)));
  const erasable = Object.entries(CLOSING).filter(([p, r]) => r.how === "erase" && !p.includes("*")).map(([p]) => p);
  is(`the closing store has a key in every family the walk erases (${erasable.length})`, erasable.filter((p) => !families.has(p)), []);
  is(`and its records are many (${ofClosing.length}), some of them in what the other store keeps too (${touched.length})`, [ofClosing.length > 400, touched.length > 3], [true, true]);
  const longest = ofClosing.reduce((most, key) => (key.length > most.length ? key : most), "");
  is(`every key it made has a name no longer than the registry prices (${KEY_NAME_BYTES}): ${longest}`, [longest.length <= KEY_NAME_BYTES, longest.length > 40], [true, true]);
  const namesClosing = (key: string, value: string) => closingMarks.some((m) => key.includes(m) || value.includes(m)) || key.split(":").includes(close.store.handle) || value.includes(`"${close.store.handle}"`);

  // ---------------------------------------------------------------- its plan ends, and its notices go out
  const realNow = Date.now;
  Date.now = () => ended;
  await setSubscription(storeRef(close.store), { active: false });
  Date.now = realNow;
  const E = Date.parse((await storeForEmail(CLOSER))!.planEndedAt);
  is("its plan ended after October 18, 2026, so the whole store closes", E, ended);
  const M = CLOSING_DAYS - WARN_MONTH_DAYS, W = CLOSING_DAYS - WARN_WEEK_DAYS;
  const told = [];
  for (const day of [0, M, W]) told.push((await closeOne(CLOSER, E + day * DAY + 60_000, hands, Number.POSITIVE_INFINITY)).note);
  is("three notices, on their days", told, ["ended", "month", "week"]);
  const notices = sent.filter((m) => m.to === CLOSER);
  is(
    "each names the day, what goes, that no copy of its sales is kept, its students' certificates and where to download everything",
    notices.map((m) => [m.text.includes("your store closes"), m.text.includes("everything else it keeps with us is"), m.text.includes("We keep no copy of your sales"), m.text.includes("course certificates"), m.text.includes("/studio#closing"), m.text.includes("you can download it once")]),
    [[true, true, true, true, true, true], [true, true, true, true, true, true], [true, true, true, true, true, true]],
  );
  const holds = stripe.posted.map((p) => [p.account, p.body.includes("pause_collection%5Bbehavior%5D=void")]);
  is("before the day nothing is touched, but its members' charges were held on the day its plan ended, on its own Stripe account only", [(await closeOne(CLOSER, E + (CLOSING_DAYS - 1) * DAY, hands, Number.POSITIVE_INFINITY)).state, files.size, holds], ["waiting", 2, [[close.store.stripeAccountId, true], [close.store.stripeAccountId, true]]]);
  const buyerMail = sent.filter((m) => m.to === tess);
  is("its buyer was told once, by Marktmorgen, at least seven days before its day", [buyerMail.length, buyerMail[0]?.subject, buyerMail[0]?.text.includes("download what can be downloaded")], [1, "closing-shop closes on " + new Date(E + CLOSING_DAYS * DAY + 60_000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }), true]);

  // ---------------------------------------------------------------- its day
  const day = await closeOne(CLOSER, E + CLOSING_DAYS * DAY + 60_000, hands, Number.POSITIVE_INFINITY);
  is("on its day its files go and it is put in line for the walk", [day.state, [...files.keys()].some((p) => p.includes(closeFolder)), [...files.keys()].some((p) => p.includes(keepFolder))], ["removed", false, true]);
  is("its memberships end at once on its day, not at the end of a period, on its own Stripe account only", stripe.posted.filter((p) => p.body === "DELETE").map((p) => [p.account, p.path.startsWith("/subscriptions/sub_")]), [[close.store.stripeAccountId, true], [close.store.stripeAccountId, true]]);

  // ---------------------------------------------------------------- the walk
  let report = await eraseClosed(Date.now() + 60_000, finishClosed, E + CLOSING_DAYS * DAY + 3_600_000);
  for (let run = 0; run < 20 && !report.done; run += 1) report = await eraseClosed(Date.now() + 60_000, finishClosed, E + CLOSING_DAYS * DAY + 3_600_000);
  is("the walk reads the database to its end and finishes the store", [report.done, report.finished], [true, 1]);
  const after = await snapshot();

  // ---------------------------------------------------------------- the file store
  is("nothing of it is in the file store: nothing was copied anywhere", [...files.keys()].filter((p) => p.includes(closeFolder)), []);

  // ---------------------------------------------------------------- the database
  const ttlOf = new Map<string, number>();
  const leftNew = [...after.keys()].filter(isNew);
  const named = [...after].filter(([key, value]) => !fixture(key) && namesClosing(key, value)).map(([key]) => key);
  const suspects = [...new Set([...leftNew, ...named])];
  const ttls = await redisPipeline(suspects.map((key) => ["TTL", key]));
  suspects.forEach((key, i) => ttlOf.set(key, Number(ttls[i])));
  const company = suspects.filter((key) => ruleOf(key)?.how === "company");
  console.log(`  (kept as the company's: ${company.map((key) => key.replace(/[0-9a-f]{24,}/g, "…")).join(", ")})`);
  const byThemselves = suspects.filter((key) => {
    const days = keptDays(key, soldClosing.includes(key));
    const ttl = ttlOf.get(key) ?? -1;
    return (ruleOf(key)?.how !== "company" || (soldClosing.includes(key) && key.startsWith("nl:ship:done:"))) && days > 0 && ttl > 0 && ttl <= days * 86_400;
  });
  console.log(`  (gone by themselves later: ${byThemselves.length}, of ${[...new Set(byThemselves.map((key) => closingFamilyOf(key)))].join(", ")})`);
  is("of what the closed store made, and of what names it, only the company's records and what is gone by itself within its days are left", suspects.filter((key) => !company.includes(key) && !byThemselves.includes(key)), []);
  is("and what is left by itself that holds an address, but what a sale left under its own reference, is gone within sixty days", byThemselves.filter((key) => !soldClosing.includes(key) && (after.get(key) ?? "").includes("@") && (ttlOf.get(key) ?? 0) > 60 * 86_400), []);
  is("what was reached only through its records is gone", reachedClosing.filter((key) => after.has(key)), []);
  is("what each sale left under its own reference is left to run out, within its family's days", soldClosing.filter((key) => !byThemselves.includes(key) && after.has(key)), []);
  is("the store is gone, and its address is held back from anybody else", [await storeForEmail(CLOSER), (await claimHandle("stranger@example.com", "closing-shop", "Not Theirs", "")).ok], [null, false]);

  // ---------------------------------------------------------------- the other store
  // A person's record across stores keeps the closed store's id until its quarter runs out, pointing at nothing (CLOSING, lapses).
  const lapsing = (key: string) => ruleOf(key)?.how === "lapses";
  const withoutClosed = (value: string | undefined) => JSON.stringify((JSON.parse(value ?? "[]") as string[]).filter((m) => m !== close.store.sid).sort());
  is("a person's records the other store is in keep it, and gain only the closed store's id", [...alone.keys()].filter((key) => lapsing(key) && withoutClosed(after.get(key)) !== withoutClosed(alone.get(key))), []);
  const changed = [...alone.keys()].filter((key) => !fixture(key) && ruleOf(key)?.how !== "company" && !lapsing(key) && after.get(key) !== alone.get(key));
  for (const key of changed.slice(0, 5)) console.log("    CHANGED", key, "\n      was", alone.get(key)?.slice(0, 200), "\n      now", after.get(key)?.slice(0, 200));
  is("everything the other store had before the closing store came is exactly as it was, the lists both were in included", changed, []);
  const library = await storesKnownFor(tess);
  is("the shared buyer's library shows the other store alone: the closed one's id points at nothing", [(await Promise.all(library.map((sid) => storeForId(sid)))).filter(Boolean).map((s) => s!.handle), library.includes(close.store.sid), await storeForId(close.store.sid)], [["keep-shop"], true, null]);
  is("the shared helper is on the other store's team alone", (await memberStores("helper@example.com")).map((m) => m.store.handle), ["keep-shop"]);
  is("and everything reached through the other store's records is there", [...reachedKeeping, ...soldKeeping].filter((key) => !after.has(key)), []);
  is("its files are where they were", [...files.keys()].filter((p) => p.includes(keepFolder)).length, 1);
  is("its owner was never written to", sent.filter((m) => m.to === KEEPER).length, 0);

  // ---------------------------------------------------------------- told three times, and done
  const closed = sent.filter((m) => m.to === CLOSER);
  is("the closed store's owner was told three times before its day, and not written to again", [closed.length, closed.at(-1)?.subject.endsWith("closing-shop closes")], [3, true]);
  is("a walk again finds nothing to do", [(await eraseClosed(Date.now() + 60_000, finishClosed, E + (CLOSING_DAYS + 2) * DAY)).deleted, sent.filter((m) => m.to === CLOSER).length], [0, 3]);
  is("and the daily job does not look at it again", (await closeEnded(Date.now() + 20_000, E + (CLOSING_DAYS + 2) * DAY, hands)).filter((row) => row.key === CLOSER), []);
}
