/**
 * 662 [OF1], the affiliate routes of a store switched off after notices about
 * its content (lib/takedown.ts, `store.suspended`), as its affiliate page
 * (tests/of1-suspended-visitor-pages.test.ts): a direct POST takes no new
 * affiliate. The refusal is the program's own (lib/affiliates.ts,
 * takesNewAffiliates, read by canApply, buyersJoin and openAffiliateLink), so
 * every way in closes at once:
 *
 *   - app/api/store/affiliates/apply: no link is emailed and nothing is
 *     counted or written;
 *   - app/api/store/affiliates/join: no buyer joins after an order, the order
 *     is not read from the creator's Stripe account and nothing of the program
 *     is written;
 *   - app/api/store/affiliates/open: a link for an address the store has no
 *     affiliate under makes no application, and the creator's invitation
 *     (grant.k) approves nobody, each kept for when the store is back; nor does
 *     the store's partnership offer accepted in a creator's studio;
 *   - a link of an affiliate it already has still signs them in.
 *
 * Each refusal sends the browser to the page with the existing "unavailable"
 * status, which, switched off, shows only the store's "not available" page: no
 * new words. Switched back on, each route is as it was. Through the real POST
 * handlers, on a synthetic store, with no real email or payment.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as applyRoute } from "@/app/api/store/affiliates/apply/route";
import { POST as joinRoute } from "@/app/api/store/affiliates/join/route";
import { POST as openRoute } from "@/app/api/store/affiliates/open/route";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { acceptPartnership, affiliateByEmail, affiliateCookieName, buyersJoin, canApply, openAffiliateLink } from "@/lib/affiliates";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
process.env.STRIPE_SECRET_KEY = "sk_test_of1_affiliate_routes";

const HANDLE = "kilnhouse";
const sessions = new Map<string, Record<string, unknown>>();
const calls = { stripe: 0, email: 0 };
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const checkout = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/);
  if (checkout) {
    calls.stripe += 1;
    const found = sessions.get(checkout[1]);
    return new Response(JSON.stringify(found ?? { error: { message: "No such checkout.session" } }), { status: found ? 200 : 404 });
  }
  if (url.hostname.includes("resend")) {
    calls.email += 1;
    return new Response(JSON.stringify({ id: `re_${calls.email}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

/** Every command that is not a read: what a refusal must not send to Redis. */
const READS = new Set(["GET", "MGET", "HGET", "HMGET", "HGETALL", "HLEN", "HEXISTS", "HSTRLEN", "EXISTS", "TTL", "PTTL", "STRLEN", "SMEMBERS", "SISMEMBER", "SCARD", "ZRANGE", "ZRANGEBYSCORE", "ZSCORE", "ZCARD", "LRANGE", "LLEN", "TYPE"]);
const real = redis.pipeline.bind(redis);
let writes: string[] = [];
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) if (!READS.has(String(command[0]).toUpperCase())) writes.push(`${command[0]} ${command[1]}`);
  return real(commands);
}) as typeof redis.pipeline;
/** A write of the program's own records (affiliates, addresses, codes, links, sessions), not a rate counter. */
const programWrites = (list: string[]) => list.filter((w) => w.split(" ")[1]?.startsWith("nl:aff:"));

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

const post = (route: (request: NextRequest) => Promise<Response>, path: string, fields: Record<string, string>) =>
  route(
    new NextRequest(`https://marktmorgen.com/api/store/affiliates/${path}`, {
      method: "POST",
      headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
      body: new URLSearchParams(fields).toString(),
    }),
  );

/** What a POST did: its status, where it sent the browser, whether it signed one in, and what it wrote, sent or read. */
async function measured(run: () => Promise<Response>) {
  writes = [];
  const before = { ...calls };
  const response = await run();
  const cookie = response.headers.get("set-cookie") ?? "";
  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
    signedIn: cookie.includes(`${affiliateCookieName(HANDLE)}=`) && !cookie.includes("Max-Age=0"),
    writes: [...writes],
    emails: calls.email - before.email,
    stripe: calls.stripe - before.stripe,
  };
}

const PAGE = `https://marktmorgen.com/@${HANDLE}/affiliates`;
const REFUSED = `${PAGE}?status=unavailable`;

async function main(): Promise<void> {
  redis.clear();
  const owner = "of1-routes@example.test";
  await claimHandle(owner, HANDLE, "Kiln House", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestKiln00001", true);
  await setSubscription(owner, { customerId: "cus_of1routes", subscriptionId: "sub_of1routes", active: true, tier: "creator", period: paidPeriod() });
  const course = await addProduct(owner, "Kiln Firing Course", "", "40", null);
  if (!course.ok) throw new Error("the product fixture was not created");
  await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, buyers: true, percent: 10, days: 60, rule: "last", payday: 0, hold: 0, rates: {} }));
  const load = async () => (await storeForEmail(owner))!;
  const statsId = (await load()).statsId!;
  let tokens = 0;
  const emailed = async (email: string, extra: Record<string, unknown> = {}) => {
    const token = String(++tokens).padStart(64, "e");
    await real([["SET", linkKey(token), JSON.stringify({ s: statsId, e: email, n: "", ...extra }), "EX", 600]]);
    return token;
  };
  const invitation = (email: string) => emailed(email, { k: 1, p: { percent: 10, products: [course.product.id] } });
  sessions.set("cs_test_of1buyer000001", {
    id: "cs_test_of1buyer000001",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 4000,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: "buyer@example.test" },
    metadata: { store: HANDLE, product: course.product.id },
  });

  // An affiliate the store already has, waiting on the creator's answer.
  const opened = await openAffiliateLink(await load(), await emailed("partner@example.test"));
  if (!opened.ok || opened.affiliate.status !== "pending") throw new Error("the affiliate fixture was not created");
  const status = async (email: string) => (await affiliateByEmail(await load(), email))?.status ?? null;

  await noteTakedown(owner, null, true);
  if (!(await load()).suspended) throw new Error("the store was not switched off");

  part("Switched off (lib/takedown.ts): the program itself takes nobody new");
  is("canApply and buyersJoin say no for the suspended store", [canApply(await load()), buyersJoin(await load())], [false, false]);

  part("app/api/store/affiliates/apply: a direct POST emails no link");
  const applied = await measured(() => post(applyRoute, "apply", { handle: HANDLE, email: "newcomer@example.test", note: "My pottery blog" }));
  is("the browser goes back to the page as unavailable", [applied.status, applied.location], [303, REFUSED]);
  is("no email is sent and nothing is counted or written", [applied.emails, applied.writes], [0, []]);
  is("no affiliate is made for the address", await status("newcomer@example.test"), null);

  part("app/api/store/affiliates/join: a buyer's direct POST after an order makes no affiliate");
  const joined = await measured(() => post(joinRoute, "join", { handle: HANDLE, order: "cs_test_of1buyer000001" }));
  is("the browser goes back to the page as unavailable, signed in to nothing", [joined.status, joined.location, joined.signedIn], [303, REFUSED, false]);
  is("no email is sent, the order is not read from Stripe and nothing of the program is written", [joined.emails, joined.stripe, programWrites(joined.writes)], [0, 0, []]);
  is("no affiliate is made for the buyer", await status("buyer@example.test"), null);

  part("app/api/store/affiliates/open: a direct POST makes no application and approves nobody");
  const fresh = await emailed("newcomer@example.test");
  const opening = await measured(() => post(openRoute, "open", { handle: HANDLE, token: fresh }));
  is("a link for a new address goes back to the page as unavailable, signed in to nothing", [opening.status, opening.location, opening.signedIn], [303, REFUSED, false]);
  is("no email is sent and nothing of the program is written", [opening.emails, programWrites(opening.writes)], [0, []]);
  is("no application is made, and the link is kept", [await status("newcomer@example.test"), (await real([["EXISTS", linkKey(fresh)]]))[0]], [null, 1]);
  const invited = await invitation("partner@example.test");
  const accepting = await measured(() => post(openRoute, "open", { handle: HANDLE, token: invited }));
  is("the creator's invitation approves nobody, signs in nobody and writes nothing of the program", [await status("partner@example.test"), accepting.location, accepting.signedIn, accepting.emails, programWrites(accepting.writes)], ["pending", REFUSED, false, 0, []]);
  is("and is kept for when the store is back", (await real([["EXISTS", linkKey(invited)]]))[0], 1);
  const guestInvited = await invitation("guest@example.test");
  const guest = await measured(() => post(openRoute, "open", { handle: HANDLE, token: guestInvited }));
  is("nor makes a partner of a new address", [await status("guest@example.test"), guest.signedIn, guest.emails, programWrites(guest.writes)], [null, false, 0, []]);
  writes = [];
  const studio = await acceptPartnership(await load(), "studio@example.test", { percent: 10, products: [course.product.id] });
  is("nor does a creator accepting the store's partnership offer in their own studio, with nothing written", [studio.ok, studio.ok ? "" : studio.reason, await status("studio@example.test"), writes], [false, "unavailable", null, []]);
  const back = await emailed("partner@example.test");
  const signing = await measured(() => post(openRoute, "open", { handle: HANDLE, token: back }));
  is("an emailed link of an affiliate the store already has still signs them in, as they were", [signing.location, signing.signedIn, await status("partner@example.test")], [`${PAGE}?status=welcome`, true, "pending"]);

  part("Switched back on, every route is as it was");
  await noteTakedown(owner, null, false);
  const again = await measured(() => post(applyRoute, "apply", { handle: HANDLE, email: "newcomer@example.test", note: "My pottery blog" }));
  is("applying emails the link again", [again.location, again.emails], [`${PAGE}?status=sent`, 1]);
  const openedAgain = await measured(() => post(openRoute, "open", { handle: HANDLE, token: fresh }));
  is("the kept link makes the application", [openedAgain.location, openedAgain.signedIn, await status("newcomer@example.test")], [`${PAGE}?status=applied`, true, "pending"]);
  const acceptedAgain = await measured(() => post(openRoute, "open", { handle: HANDLE, token: invited }));
  is("the kept invitation approves the affiliate", [acceptedAgain.signedIn, await status("partner@example.test")], [true, "approved"]);
  const joinedAgain = await measured(() => post(joinRoute, "join", { handle: HANDLE, order: "cs_test_of1buyer000001" }));
  is("a buyer joins after an order again, read from Stripe", [joinedAgain.location, joinedAgain.signedIn, joinedAgain.stripe > 0, await status("buyer@example.test")], [`${PAGE}?status=joined`, true, true, "approved"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
