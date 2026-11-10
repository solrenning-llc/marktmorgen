/**
 * One invitation to move here opens one checkout at a time, for that checkout's own life (Claude 4 on #2690, B2-B4,
 * proof claude4/review-2690-proof@f5c2bc67): the mark that says "this invitation has a checkout open" lives as long
 * as Stripe keeps that checkout open, and a minute; it is let go only when nothing was made at Stripe; and once it is
 * gone, a membership Stripe already shows live opens nothing more. Stripe is a stand-in; nothing real is charged.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { inviteMembers, openMove, readInvite } from "@/lib/move-members";
import { store as redis, advance } from "./redis-stub";
import { done, is, part } from "./check";
import { moveWords } from "@/lib/buyer-words/move";
import { LANGUAGE_CODES as LANGUAGES } from "@/lib/store-language";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "move-open-mark@example.com";
const checkouts: URLSearchParams[] = [];
/** expires_at Stripe gave each session, by id; a session with none closes in 24 hours. */
const closes = new Map<string, number>();
let lostAnswer = false;
let refusedByStripe = false;
let sessionUnreadable = false;
/** Stripe answers the creation with the checkout's own expires_at, as the API does; off to play an answer without it. */
let postSaysCloses = true;
/** GET /checkout/sessions/:id reads, to show none is needed when the creation said when it closes. */
let sessionReads = 0;
/** The emails Stripe shows a live membership to this product for. */
const paid = new Set<string>();
let membershipsUnreadable = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    if (refusedByStripe) {
      refusedByStripe = false;
      return json({ error: { type: "invalid_request_error", message: "No such price." } }, 400);
    }
    const body = new URLSearchParams(String(init?.body));
    checkouts.push(body);
    const id = `cs_test_${"m".repeat(20)}${checkouts.length}`;
    closes.set(id, Number(body.get("expires_at")) || Math.floor(Date.now() / 1000) + 86_400);
    // Stripe made the session, then its answer was lost on the way back.
    if (lostAnswer) {
      lostAnswer = false;
      throw new TypeError("fetch failed: socket hang up");
    }
    return json({ id, url: `https://checkout.stripe.com/c/pay/test${checkouts.length}`, ...(postSaysCloses ? { expires_at: closes.get(id) } : {}) });
  }
  const session = /^\/checkout\/sessions\/(cs_test_\w+)$/.exec(path);
  if (session && method === "GET") {
    sessionReads += 1;
    if (sessionUnreadable) return json({ id: session[1], object: "checkout.session" });
    const at = closes.get(session[1]);
    return at ? json({ id: session[1], object: "checkout.session", expires_at: at, status: at > Date.now() / 1000 ? "open" : "expired" }) : json({ error: { message: "No such session" } }, 404);
  }
  if (path === "/customers" && method === "GET") {
    if (membershipsUnreadable) return json({ object: "list" });
    const email = url.searchParams.get("email") ?? "";
    return json({ object: "list", data: paid.has(email) ? [{ id: `cus_${email.split("@")[0]}Paid0` }] : [], has_more: false });
  }
  if (path === "/subscriptions" && method === "GET") {
    const customer = url.searchParams.get("customer") ?? "";
    const email = [...paid].find((e) => customer === `cus_${e.split("@")[0]}Paid0`);
    return json({ object: "list", data: email ? [{ id: "sub_Paid0001", status: "active", metadata: { product: productId, moved: "yes" } }] : [], has_more: false });
  }
  if (method === "GET") return json({ object: "list", data: [], has_more: false });
  return json({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

let productId = "";

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_open_mark_only";
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  const nowS = Math.floor(Date.now() / 1000);
  const made = await claimHandle(OWNER, "moveopenmark", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMvMark01", true);
  await setSubscription(OWNER, { customerId: "cus_MvMark01", subscriptionId: "sub_MvMark01", active: true, period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Austin, TX 78701", asks: true });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  productId = club.product.id;
  await addOption(OWNER, productId, "Basic", "19");
  let store = (await storeForEmail(OWNER))!;
  const [basic] = (await readProduct(store, productId))!.options.map((o) => o.id);
  await setProductLink(OWNER, basic, "https://example.com/basic");
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const people = ["ada", "ben", "cy", "dee", "eve", "fay", "gus", "hal", "ivy"];
  const fields = await inviteMembers(store, "job_moveopenmark", people.map((name) => ({ email: `${name}@example.com`, productId, option: basic, renews: nowS + 20 * 86_400 })));
  // inviteMembers answers false for an address deleted from the store (main, 573513b4): none is here.
  if (!fields.every((field): field is string => typeof field === "string")) throw new Error("not invited");
  const invites = Object.fromEntries(await Promise.all(people.map(async (name, i) => [name, (await readInvite(statsId, fields[i]!))!] as const)));
  const press = (name: string) => openMove(store, productId, invites[name].t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  const mark = (name: string) => `nl:mv:open:${statsId}:${fields[people.indexOf(name)]}`;
  is("the store sends abandoned-checkout reminders, so its checkouts close in an hour", store.recovery.enabled, true);

  part("B2: the mark lives as long as its checkout, and a minute");
  const a1 = await press("ada");
  is("Ada's checkout opens", a1.ok, true);
  const life = Number(checkouts.at(-1)!.get("expires_at")) - Math.floor(Date.now() / 1000);
  const ttl = Number(redis.run(["TTL", mark("ada")]));
  is("the checkout closes in about an hour", life > 3_500 && life <= 3_600, true);
  is("the mark lives no longer than the checkout and a minute", ttl > life && ttl <= life + 60, true);
  const a2 = await press("ada");
  is("pressed again while it is open: the same checkout, none made", [a2.ok && a1.ok ? a2.url === a1.url : false, checkouts.length], [true, 1]);
  advance(2 * 3_600 * 1000);
  const a3 = await press("ada");
  is("two hours later, its checkout closed unpaid: a live one, not the closed one", a3.ok && a1.ok ? (a3.url === a1.url ? "the closed one" : "a live one") : a3.ok ? "a live one" : a3.reason, "a live one");

  part("The closing time Stripe gave when the checkout was made is used, with no second read (Claude 4 A3 on #2690)");
  sessionUnreadable = true;
  const readsBefore = sessionReads;
  const i1 = await press("ivy");
  sessionUnreadable = false;
  const ivyLife = Number(checkouts.at(-1)!.get("expires_at")) - Math.floor(Date.now() / 1000);
  const ivyTtl = Number(redis.run(["TTL", mark("ivy")]));
  is("opened; the mark lives as long as that checkout and a minute, though the session cannot be read", [i1.ok, ivyTtl > ivyLife && ivyTtl <= ivyLife + 60], [true, true]);
  is("and the session was not read again", sessionReads - readsBefore, 0);

  part("A checkout whose closing time cannot be read keeps the mark for the longest a checkout lives");
  sessionUnreadable = true;
  postSaysCloses = false;
  const g1 = await press("gus");
  sessionUnreadable = false;
  postSaysCloses = true;
  const longest = Number(redis.run(["TTL", mark("gus")]));
  is("opened, and the mark kept a day and a minute (no second checkout while one may be open)", [g1.ok, longest > 86_400 && longest <= 86_460], [true, true]);

  part("B3: the mark is let go only when nothing was made at Stripe");
  const before = checkouts.length;
  lostAnswer = true;
  const b1 = await press("ben");
  const b2 = await press("ben");
  // Changed assertion (rule 23, Claude 4 on #2690): the press whose answer was lost said "refused" ("try again in a
  // few minutes"); it now says, as every later press does, that the last try is still being checked.
  is("Stripe made the session but its answer was lost: the press says it is still being checked", b1.ok ? "opened" : b1.reason, "checking");
  // Changed assertion (rule 23, Revisor 1 on #2685): the second press used to say "refused" ("try again in a few
  // minutes") for a day. It now says the last try is still being checked, which is what is true.
  is("and a second press makes no second session, and says the last try is still being checked", [b2.ok ? "opened" : b2.reason, checkouts.length - before], ["checking", 1]);
  for (const language of LANGUAGES) {
    const words = moveWords(language).notices as Record<string, { title: string; body: string } | undefined>;
    is(`${language}: the words for a try still being checked exist and promise no minutes`, Boolean(words.checking?.title && words.checking.body) && !/minute|minuto|Minute|minuut|minutes/i.test(words.checking?.body ?? ""), true);
  }
  refusedByStripe = true;
  const d1 = await press("dee");
  const d2 = await press("dee");
  is("Stripe refused to make it: nothing made, so the next press opens one", [d1.ok, d2.ok, checkouts.length - before], [false, true, 2]);

  part("B4: once the mark is gone, a membership Stripe shows live opens nothing more");
  const c1 = await press("cy");
  is("Cy's first checkout opens", c1.ok, true);
  paid.add("cy@example.com");
  advance((86_400 + 61) * 1000);
  const madeBefore = checkouts.length;
  const c2 = await press("cy");
  is("after the mark: no second checkout; the link says it was moved", [c2.ok ? "opened" : c2.reason, checkouts.length - madeBefore], ["done", 0]);
  is("and the invitation now reads as kept", (await readInvite(statsId, fields[people.indexOf("cy")]!))!.kept > 0, true);
  membershipsUnreadable = true;
  const e1 = await press("eve");
  membershipsUnreadable = false;
  is("Stripe's memberships cannot be read: refused, no checkout, and the next press may try again", [e1.ok ? "opened" : e1.reason, checkouts.length - madeBefore, redis.run(["EXISTS", mark("eve")])], ["refused", 0, 0]);
  const e2 = await press("eve");
  is("read whole the next time: it opens", e2.ok, true);

  part("A5: Stripe shows the membership live and the write that notes it kept fails once (Claude 4 on #2690)");
  paid.add("hal@example.com");
  const realPipe = redis.pipeline.bind(redis);
  let failedOnce = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!failedOnce && commands.some((c) => c[0] === "HSET" && c[1] === `nl:mv:${statsId}`)) {
      failedOnce = true;
      throw new Error("redis: connection reset");
    }
    return realPipe(commands);
  }) as typeof redis.pipeline;
  let h1 = "returned";
  try {
    const r = await press("hal");
    h1 = r.ok ? "opened" : r.reason;
  } catch {
    h1 = "threw";
  } finally {
    redis.pipeline = realPipe;
  }
  is("the press says the membership was moved, and the mark is not left behind for a day", [failedOnce, h1, redis.run(["GET", mark("hal")])], [true, "done", null]);
  const h2 = await press("hal");
  is("the next press says it was moved too, and the invitation now reads as kept", [h2.ok ? "opened" : h2.reason, (await readInvite(statsId, fields[people.indexOf("hal")]!))!.kept > 0], ["done", true]);
  done();
}

void main();
