/**
 * The certificates' refund pass keeps the refunds it handled (nl:certrefunds:seen:<stats>) to a number with a ceiling,
 * so the set never outgrows the 64 KB tests/store-data-registry.ts prices for it (quality review of #3409 at
 * b5d7d28157, Claude 1 cloud, MEDIUM 2).
 *
 * The set was trimmed only below the place. A refund that stays pending holds the place at its own time, so every later
 * full refund on the creator's account was added and never trimmed: on Scale up to 5,000 a month, past 64 KB within
 * the first month. Now each write keeps only the newest CERTIFICATE_REFUND_SEEN_AT_MOST members. A handled row trimmed
 * that way is read again and handled again inside the month's checks, so the cost stays inside its line.
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import * as pass from "@/lib/certificate-refunds";
import * as certificates from "@/lib/certificate";
import { type Certificate, issueCertificate, readCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { type Store, addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { FAMILIES, partPeak } from "./store-data-registry";

process.env.STRIPE_SECRET_KEY = "sk_test_certificate_refund_seen_bound";

type Charge = { object: "charge"; id: string; amount: number; amount_refunded: number; refunded: boolean; disputed: boolean };
type Refund = { id: string; object: "refund"; created: number; status: string; amount: number; payment_intent: string; charge: Charge };
type Session = Record<string, unknown> & { id: string; created: number; customer_details: { email: string }; payment_intent: { id: string; object: "payment_intent"; latest_charge: Charge } };

const sessions: Session[] = [];
const refunds: Refund[] = [];
const listOf = (data: unknown[], url: string) => new Response(JSON.stringify({ object: "list", data, has_more: false, url }), { status: 200 });

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
    if (email) return listOf(sessions.filter((s) => s.customer_details.email === email), "/v1/checkout/sessions");
    return listOf([], "/v1/checkout/sessions");
  }
  if (path.startsWith("/payment_intents/")) return new Response(JSON.stringify({ id: path.split("/")[2], object: "payment_intent", metadata: {} }), { status: 200 });
  return listOf([], path);
}) as typeof fetch;

const secondsAgo = (n: number) => Math.floor(Date.now() / 1000) - n;
let n = 0;
const tag = () => String((n += 1)).padStart(10, "0");
function charge(): Charge {
  return { object: "charge", id: `ch_seen${tag()}`, amount: 4900, amount_refunded: 0, refunded: false, disputed: false };
}
/** A refund of `c` at `created`: in full and succeeded, or still pending. */
function refund(c: Charge, pi: string, created: number, status = "succeeded"): void {
  if (status === "succeeded") {
    c.amount_refunded = c.amount;
    c.refunded = true;
  }
  refunds.push({ id: `re_seen${tag()}`, object: "refund", created, status, amount: c.amount, payment_intent: pi, charge: c });
}

async function main(): Promise<void> {
  redis.clear();
  const exported = pass as unknown as Record<string, unknown>;
  const publicName = (certificates as unknown as { publicName: (c: Certificate) => string | null }).publicName;
  const most = exported.CERTIFICATE_REFUND_SEEN_AT_MOST;

  part("The set of rows handled has a named ceiling that fits what the registry prices");
  is("the ceiling is a named, exported count", Number.isSafeInteger(most) && (most as number) > 0, true);
  // Each member as tests/store-data-registry.ts prices a ZADD (32 + 8 bytes and the member), a quarter more; the longest
  // member is "w:" and the longest id the pass reads (4 + 1 + 64 characters).
  const memberBytes = Math.ceil((32 + 8 + 2 + 4 + 1 + 64) * 1.25);
  const priced = FAMILIES["nl:certrefunds:seen:@lib/certificate-refunds.ts"];
  const pricedBytes = (priced?.parts ?? []).reduce((sum, one) => sum + partPeak(one, "scale"), 0);
  is("the registry still prices the set at 64 KB", pricedBytes, 64 * 1024);
  is("the ceiling's worst members fit inside it", typeof most === "number" && most * memberBytes <= pricedBytes, true);

  // A Scale school, one course.
  const owner = "bound@example.com";
  await claimHandle(owner, "boundschool", "Bound School", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestSeenBound", true);
  const made = await addProduct(owner, "Course 1", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const courseId = "c5".padEnd(32, "e");
  await setProductCourse(owner, made.product.id, { id: courseId, lessons: 3 });
  const store = { ...((await storeForEmail(owner)) as Store), tier: "scale" } as Store;
  const seenKey = `nl:certrefunds:seen:${store.statsId}`;
  const count = async () => Number((await redis.pipeline([["ZCARD", seenKey]]))[0] ?? 0);
  const run = () => pass.withdrawRefundedCertificates(store, Date.now() + 60_000).catch(() => -1);

  part("MEDIUM 2: a refund kept pending holds the place while 600 other full refunds are handled");
  // The pending one, three hours ago: it holds the place at its own time for as long as it stays pending.
  const held = charge();
  refund(held, `pi_seen${tag()}`, secondsAgo(3 * 3_600), "pending");
  // 600 full refunds of charges that are not Marktmorgen sales, two hours ago: each is looked up and marked handled.
  for (let i = 0; i < 600; i += 1) refund(charge(), `pi_seen${tag()}`, secondsAgo(2 * 3_600 - i));
  let largest = 0;
  for (let p = 0; p < 40; p += 1) {
    await run();
    largest = Math.max(largest, await count());
  }
  console.log(`  (the set held at most ${largest} members)`);
  is("the set never holds more members than its ceiling", typeof most === "number" && largest <= most, true);
  is("the pending refund still holds the place (its rows are still read)", largest > 0, true);

  part("A course refunded in full after the flood is still withdrawn");
  const email = "late@example.com";
  const c = charge();
  const pi = `pi_seen${tag()}`;
  sessions.push({
    id: `cs_test_seen${tag()}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: secondsAgo(4 * 3_600),
    customer_details: { email },
    metadata: { store: "boundschool", product: made.product.id },
    payment_intent: { id: pi, object: "payment_intent", latest_charge: c },
  });
  const course = { id: courseId, certificate: true, startsAt: null, modules: [] } as unknown as Course;
  const issued = await issueCertificate({ store: storeKey(store), productId: made.product.id, course, title: "Course 1", creator: "A school", email, who: emailKey(email), name: "Late Example", room: { ...ROOM, statsId: store.statsId } });
  if (!issued.ok) throw new Error("not issued");
  refund(c, pi, secondsAgo(3_600));
  for (let p = 0; p < 40; p += 1) await run();
  is("her name is off the page", publicName((await readCertificate(issued.certificate.id)) as Certificate), null);
  is("the set still holds no more members than its ceiling", typeof most === "number" && (await count()) <= most, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
