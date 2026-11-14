/**
 * A row of the certificates' refund pass left unknown is tried again on its own share of the month's checks, at a
 * growing interval, so it never spends what withdraws a healthy refund (second focal review of #3409 at 00529a6448,
 * Claude 5, MÉDIO).
 *
 * A row left unknown waited a day and then took the checks of every course its checkout gave again, every day. A
 * checkout of five courses so took 5 x 31 checks a month, past the Store plan's 100 by day 20; from then on a healthy
 * full refund of another student was not withdrawn until the next month. Now:
 *   - a row tried again takes its checks from a part of the month's checks kept for rows tried again
 *     (CERTIFICATE_REFUND_RETRY_CHECKS_PER_MONTH), inside the month's total, so the cost does not grow;
 *   - rows tried again go after the rows read for the first time in a pass, so they never stop them;
 *   - the wait before a row is tried again grows with its age, from CERTIFICATE_REFUND_RETRY_SECONDS up to
 *     CERTIFICATE_REFUND_RETRY_MAX_SECONDS;
 *   - a row past that part holds its place and waits for the next month: unknown never withdraws, and the row is
 *     never forgotten.
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account. The clock is moved to the first
 * day of a month, so the result does not depend on the day the test runs.
 */
import * as pass from "@/lib/certificate-refunds";
import * as certificates from "@/lib/certificate";
import { type Certificate, issueCertificate, readCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { PRICES_WITHOUT_COMMISSION } from "@/lib/plan";
import { paidStorageBytes } from "@/lib/storage-rules";
import { CLOSING_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { CERTIFICATE_REFUND_LOOKBACK_SECONDS } from "@/lib/certificate-refunds";
import { type Store, addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { GB, STORAGE_PER_GB, providerFeeUsd, worstCost } from "./plan-cost-model";
import { COST_LINES } from "./plan-cost-registry";

process.env.STRIPE_SECRET_KEY = "sk_test_certificate_refund_retry_budget";

type Charge = { object: "charge"; id: string; amount: number; amount_refunded: number; refunded: boolean; disputed: boolean };
type Refund = { id: string; object: "refund"; created: number; status: string; amount: number; payment_intent: string; charge: Charge };
type Session = Record<string, unknown> & { id: string; created: number; customer_details: { email: string }; payment_intent: { id: string; object: "payment_intent"; latest_charge: Charge } };

const DAY_MS = 86_400_000;
const sessions: Session[] = [];
const refunds: Refund[] = [];
/** Buyers whose list of checkouts Stripe answers with a failure. */
const unreadable = new Set<string>();
/** The days on which each buyer's list of checkouts was asked for: one a try of their row. */
const triedOn = new Map<string, Set<number>>();

const listOf = (data: unknown[], url: string) => new Response(JSON.stringify({ object: "list", data, has_more: false, url }), { status: 200 });

// The clock the pass and the in-memory Redis both read, moved by the test: from the first day of next month, 06:00 UTC.
const realNow = Date.now;
const startOf = (() => {
  const now = new Date(realNow());
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 6);
})();
let shift = startOf - realNow();
Date.now = () => realNow() + shift;
const dayOf = () => Math.floor((Date.now() - startOf) / DAY_MS);

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response(JSON.stringify({ error: "nothing leaves this test" }), { status: 500 });
  const path = url.pathname.replace(/^\/v1/, "");
  const q = url.searchParams;
  if (path === "/refunds") {
    const charge = q.get("charge");
    if (charge) return listOf(refunds.filter((r) => r.charge.id === charge), "/v1/refunds");
    const since = Number(q.get("created[gte]") ?? 0);
    return listOf(refunds.filter((r) => r.created >= since).sort((a, b) => b.created - a.created), "/v1/refunds");
  }
  if (path === "/events") return listOf([], "/v1/events");
  if (path === "/checkout/sessions") {
    const pi = q.get("payment_intent");
    if (pi) return listOf(sessions.filter((s) => s.payment_intent.id === pi), "/v1/checkout/sessions");
    const email = q.get("customer_details[email]");
    if (email) {
      const days = triedOn.get(email) ?? new Set<number>();
      days.add(dayOf());
      triedOn.set(email, days);
    }
    if (email && unreadable.has(email)) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
    if (email) return listOf(sessions.filter((s) => s.customer_details.email === email), "/v1/checkout/sessions");
    return listOf([], "/v1/checkout/sessions");
  }
  if (path.startsWith("/payment_intents/")) return new Response(JSON.stringify({ id: path.split("/")[2], object: "payment_intent", metadata: {} }), { status: 200 });
  return listOf([], path);
}) as typeof fetch;

const hoursAgo = (n: number) => Math.floor(Date.now() / 1000) - n * 3_600;
let n = 0;
/** A paid checkout of `products`, the first as the product bought and the rest as its bundle. */
function buy(handle: string, email: string, products: string[]): Session {
  n += 1;
  const tag = String(n).padStart(10, "0");
  const charge: Charge = { object: "charge", id: `ch_retry${tag}`, amount: 4900, amount_refunded: 0, refunded: false, disputed: false };
  const metadata: Record<string, string> = { store: handle, product: products[0] };
  if (products.length > 1) metadata.bundle = products.slice(1).join(",");
  const session: Session = {
    id: `cs_test_retry${tag}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: hoursAgo(5),
    customer_details: { email },
    metadata,
    payment_intent: { id: `pi_retry${tag}`, object: "payment_intent", latest_charge: charge },
  };
  sessions.push(session);
  return session;
}
/** A full refund that succeeded two hours ago, older than the pass's wait. */
function refundInFull(session: Session): void {
  n += 1;
  const charge = session.payment_intent.latest_charge;
  charge.amount_refunded = charge.amount;
  charge.refunded = true;
  refunds.push({ id: `re_retry${String(n).padStart(10, "0")}`, object: "refund", created: hoursAgo(2), status: "succeeded", amount: charge.amount, payment_intent: session.payment_intent.id, charge });
}

type Shop = { store: Store; handle: string; products: string[]; courseIds: string[] };
async function storeWith(owner: string, handle: string, account: string, courses: number, tag: string): Promise<Shop> {
  await claimHandle(owner, handle, `School ${handle}`, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, account, true);
  const products: string[] = [];
  const courseIds: string[] = [];
  for (let i = 0; i < courses; i += 1) {
    const made = await addProduct(owner, `Course ${i + 1}`, "", "49", null);
    if (!made.ok) throw new Error("no product");
    const courseId = `${tag}${String(i).padStart(2, "0")}`.padEnd(32, "e");
    await setProductCourse(owner, made.product.id, { id: courseId, lessons: 3 });
    products.push(made.product.id);
    courseIds.push(courseId);
  }
  return { store: (await storeForEmail(owner))!, handle, products, courseIds };
}

async function main(): Promise<void> {
  redis.clear();
  const exported = pass as unknown as Record<string, unknown>;
  const publicName = (certificates as unknown as { publicName: (c: Certificate) => string | null }).publicName;
  const record = async (id: string) => (await readCertificate(id)) as Certificate | null;
  const stands = async (id: string) => ((await record(id))?.withdrawnAt ?? 0) === 0;
  const issue = async (shop: Shop, email: string, name: string) => {
    const course = { id: shop.courseIds[0], certificate: true, startsAt: null, modules: [] } as unknown as Course;
    const issued = await issueCertificate({ store: storeKey(shop.store), productId: shop.products[0], course, title: "Course 1", creator: "A school", email, who: emailKey(email), name, room: { ...ROOM, statsId: shop.store.statsId } });
    if (!issued.ok) throw new Error("not issued");
    return issued.certificate.id;
  };
  const run = (shop: Shop) => pass.withdrawRefundedCertificates(shop.store, Date.now() + 60_000).catch(() => -1);
  const total = async (shop: Shop) => Number((await redis.pipeline([["GET", `nl:certrefunds:n:${shop.store.statsId}:${new Date(Date.now()).toISOString().slice(0, 7)}`]]))[0] ?? 0);
  const checks = exported.CERTIFICATE_REFUND_CHECKS_PER_MONTH as Record<string, number>;
  const retries = exported.CERTIFICATE_REFUND_RETRY_CHECKS_PER_MONTH as Record<string, number> | undefined;
  const tiers = ["creator", "pro", "scale"] as const;

  part("The month's checks keep a part for rows tried again, inside the same total");
  is("the part for rows tried again is a named, exported figure for each plan", tiers.every((tier) => Number.isSafeInteger(retries?.[tier]) && (retries?.[tier] ?? 0) > 0), true);
  is("it is a part of the month's checks, so the rows read for the first time keep most of them", tiers.every((tier) => (retries?.[tier] ?? Infinity) * 2 < checks[tier]), true);
  const most = exported.CERTIFICATE_REFUND_RETRY_MAX_SECONDS;
  is("the longest wait before a row is tried again is a named, exported time", typeof most === "number" && most >= (exported.CERTIFICATE_REFUND_RETRY_SECONDS as number), true);
  is("a wait never outlives the set of rows handled that keeps it (fifteen days after the last write)", typeof most === "number" && most < CERTIFICATE_REFUND_LOOKBACK_SECONDS * 2 + 86_400, true);

  part("The line prices the part for rows tried again, and the Store plan's first year given back stays under US$ 65");
  const line = COST_LINES.find((one) => one.id === "certificate-refund-pass");
  is("the line names the part for rows tried again and the longest wait", Boolean(line?.sources.some((s) => s.file === "lib/certificate-refunds.ts" && ["CERTIFICATE_REFUND_RETRY_CHECKS_PER_MONTH", "CERTIFICATE_REFUND_RETRY_MAX_SECONDS"].every((name) => s.names.includes(name)))), true);
  {
    const kept = (paidStorageBytes("creator") / GB) * STORAGE_PER_GB * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30);
    const year = worstCost("creator") + providerFeeUsd(PRICES_WITHOUT_COMMISSION.creator.year) + kept;
    is(`the first year given back is under US$ 65 (US$ ${year.toFixed(4)})`, year < 65, true);
  }

  // Two Store stores: one where the row left unknown is a checkout of five courses, one where it is of one (the control).
  const five = await storeWith("five@example.com", "fiveschool", "acct_1TestRetryFive", 6, "f5");
  const one = await storeWith("one@example.com", "oneschool", "acct_1TestRetryOne", 1, "a1");
  is("both stores are on the Store plan", [five.store.tier, one.store.tier], ["creator", "creator"]);
  const stuckFive = buy(five.handle, "stuck5@example.com", five.products.slice(0, 5));
  const stuckFiveId = await issue(five, "stuck5@example.com", "Stuck Five");
  const stuckOne = buy(one.handle, "stuck1@example.com", one.products.slice(0, 1));
  const stuckOneId = await issue(one, "stuck1@example.com", "Stuck One");
  refundInFull(stuckFive);
  refundInFull(stuckOne);
  unreadable.add("stuck5@example.com");
  unreadable.add("stuck1@example.com");

  part("MÉDIO: a row of five courses left unknown, one pass a day for 21 days, in one month");
  for (let day = 0; day < 21; day += 1) {
    await run(five);
    await run(one);
    shift += DAY_MS;
  }
  is("unknown never withdraws: the five-course row's certificate still stands", await stands(stuckFiveId), true);
  is("unknown never withdraws: the one-course row's certificate still stands", await stands(stuckOneId), true);
  const fiveTries = triedOn.get("stuck5@example.com")?.size ?? 0;
  const oneTries = triedOn.get("stuck1@example.com")?.size ?? 0;
  console.log(`  (tried on ${fiveTries} and ${oneTries} of 21 days)`);
  is("the five-course row is tried again, never forgotten (more than one day)", fiveTries > 1, true);
  is("the five-course row is tried at a growing interval, not every day (at most 8 of 21 days)", fiveTries <= 8, true);
  is("the one-course row too", oneTries > 1 && oneTries <= 8, true);
  is("the month's checks taken stay within the Store plan's total", (await total(five)) <= checks.creator, true);

  part("MÉDIO: a healthy full refund the next day is withdrawn within the month");
  const zoeFive = buy(five.handle, "zoe5@example.com", five.products.slice(0, 1));
  const zoeFiveId = await issue(five, "zoe5@example.com", "Zoe Example");
  refundInFull(zoeFive);
  const zoeOne = buy(one.handle, "zoe1@example.com", one.products.slice(0, 1));
  const zoeOneId = await issue(one, "zoe1@example.com", "Zoe Example");
  refundInFull(zoeOne);
  const month = new Date(Date.now()).toISOString().slice(0, 7);
  for (let i = 0; i < 3; i += 1) {
    await run(five);
    await run(one);
  }
  is("still the same month", new Date(Date.now()).toISOString().slice(0, 7), month);
  is("after a five-course row left unknown for 21 days, her name is off the page", publicName((await record(zoeFiveId))!), null);
  is("after a one-course row left unknown for 21 days, her name is off the page (control)", publicName((await record(zoeOneId))!), null);
  is("the rows left unknown still stand", [await stands(stuckFiveId), await stands(stuckOneId)], [true, true]);

  part("Never forgotten: once the buyer's courses read, the row is tried again and withdrawn, the next month at the latest");
  unreadable.delete("stuck5@example.com");
  unreadable.delete("stuck1@example.com");
  const first = new Date(startOf);
  const lastDay = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 6);
  while (Date.now() + DAY_MS < lastDay + 3_600_000) {
    shift += DAY_MS;
    await run(five);
    await run(one);
  }
  is("the month's last day", new Date(Date.now()).toISOString().slice(0, 10), new Date(lastDay).toISOString().slice(0, 10));
  is("the one-course row, inside the part for rows tried again, is withdrawn within the month", publicName((await record(stuckOneId))!), null);
  is("the five-course row, past that part, holds its place and waits for the next month", await stands(stuckFiveId), true);
  const next = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 2, 6);
  while (Date.now() < next) {
    shift += DAY_MS;
    await run(five);
    await run(one);
  }
  is("the five-course row is withdrawn (no name on the page)", publicName((await record(stuckFiveId))!), null);
  is("the one-course row is withdrawn (no name on the page)", publicName((await record(stuckOneId))!), null);

  // Focal of Claude 4 at db9262b3 (MÉDIO): the part for rows tried again let a whole take through while the part was
  // not spent before it, so on the Store plan (part 25) two 20-course rows passed it (0 -> 20, 20 -> 40) and the second
  // took the month's checks past its total; a healthy full refund later in the month was then not withdrawn.
  part("MÉDIO: three rows of 20 courses left unknown never spend the checks a healthy refund needs");
  // A month of its own: the first day of the month after the one the parts above ended in, 06:00 UTC.
  const at = new Date(Date.now());
  shift = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 6) - realNow();
  const wideMonth = new Date(Date.now()).toISOString().slice(0, 7);
  // Course ids must read as course ids (32 hex characters), so the tag is hex: a course that does not read is no course,
  // and its row would be marked handled without ever asking for the buyer's courses.
  const wide = await storeWith("wide@example.com", "wideschool", "acct_1TestRetryWide", 20, "b2");
  is("the school is on the Store plan, with 20 courses", [wide.store.tier, wide.courseIds.length], ["creator", 20]);
  const stuckWideIds: string[] = [];
  for (const i of [1, 2, 3]) {
    const email = `stuckw${i}@example.com`;
    const stuck = buy(wide.handle, email, wide.products.slice(0, 20));
    stuckWideIds.push(await issue(wide, email, `Stuck Wide ${i}`));
    refundInFull(stuck);
    unreadable.add(email);
  }
  // Another row of the same day, read and withdrawn at once: a five-course bundle, 5 checks and 1 to mark it handled.
  const early = buy(wide.handle, "earlyw@example.com", wide.products.slice(0, 5));
  const earlyId = await issue(wide, "earlyw@example.com", "Early Example");
  refundInFull(early);
  for (let day = 0; day < 10; day += 1) {
    for (let p = 0; p < 3; p += 1) await run(wide);
    shift += DAY_MS;
  }
  const wideTries = [1, 2, 3].map((i) => triedOn.get(`stuckw${i}@example.com`)?.size ?? 0);
  is("each 20-course row was tried on its first day (its buyer's courses asked for)", wideTries.every((tries) => tries >= 1), true);
  is("after the first day, rows were tried again", wideTries.some((tries) => tries >= 2), true);
  is("the other row of day 0 is withdrawn (no name on the page)", publicName((await record(earlyId))!), null);
  is("unknown never withdraws: the three 20-course rows' certificates still stand", await Promise.all(stuckWideIds.map(stands)), [true, true, true]);
  is("the month's checks taken stay within the Store plan's total", (await total(wide)) <= checks.creator, true);
  const zoeWide = buy(wide.handle, "zoew@example.com", wide.products.slice(0, 1));
  const zoeWideId = await issue(wide, "zoew@example.com", "Zoe Example");
  refundInFull(zoeWide);
  for (let p = 0; p < 3; p += 1) await run(wide);
  is("still the same month (day 10)", new Date(Date.now()).toISOString().slice(0, 7), wideMonth);
  is("a healthy full refund on day 10 is withdrawn within the month (no name on the page)", publicName((await record(zoeWideId))!), null);
  is("the month's checks taken still stay within the Store plan's total", (await total(wide)) <= checks.creator, true);

  Date.now = realNow;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
