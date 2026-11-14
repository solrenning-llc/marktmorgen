/**
 * The certificates' refund pass keeps a pace the Store plan's margin pays for, and a row it cannot read never spends
 * the month's checks (focal review of #3409 at 8769437846, Claude 5: ALTO 2, MÉDIO 2, L1, L2).
 *
 * ALTO 2: the pass ran every five minutes for every store that issued a certificate, priced at US$ 0.79 a store a
 * month, which took the Store plan's first year given back from US$ 64.97 to US$ 65.77, above the US$ 65 the owner
 * keeps (tests/plan-margin.test.ts, tests/read-ceilings.test.ts). Now the sweep runs a store's pass at most once every
 * CERTIFICATE_PASS_EVERY_SECONDS, deciding which are due with one read for the whole batch of stores, and the
 * month's checks are a ceiling per plan.
 *
 * MÉDIO 2: a row whose buyer's courses could not be read took its checks again on every run, so one such row spent the
 * month's checks and held back every other withdrawal of the store until the next month. Now a row that took its
 * checks and was left unknown waits CERTIFICATE_REFUND_RETRY_SECONDS before it is tried again, and the rows after it
 * go on; it is never forgotten.
 *
 * L1: the privacy policy says a withdrawal can wait until the next month. L2: the INCRBY and EXPIRE a run sends once
 * the month's checks are spent are among the run's priced commands.
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { readFileSync } from "node:fs";
import * as pass from "@/lib/certificate-refunds";
import * as certificates from "@/lib/certificate";
import { type Certificate, issueCertificate, readCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { PRICES_WITHOUT_COMMISSION } from "@/lib/plan";
import { paidStorageBytes } from "@/lib/storage-rules";
import { CLOSING_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { CERTIFICATE_REFUND_PAGES_PER_STORE } from "@/lib/certificate-refunds";
import { type Store, addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { GB, STORAGE_PER_GB, providerFeeUsd, worstCost } from "./plan-cost-model";
import { CERTIFICATE_PASS_RUN_COMMANDS } from "./plan-cost-registry";

process.env.STRIPE_SECRET_KEY = "sk_test_certificate_refund_pass_pace";

type Charge = { object: "charge"; id: string; amount: number; amount_refunded: number; refunded: boolean; disputed: boolean };
type Refund = { id: string; object: "refund"; created: number; status: string; amount: number; payment_intent: string; charge: Charge };
type Session = Record<string, unknown> & { id: string; created: number; customer_details: { email: string }; payment_intent: { id: string; object: "payment_intent"; latest_charge: Charge } };

const sessions: Session[] = [];
const refunds: Refund[] = [];
/** Buyers whose list of checkouts Stripe answers with a failure. */
const unreadable = new Set<string>();
/** Reads of the creator's refunds since a time (the pass's pages), not those of one charge. */
let refundPages = 0;

const listOf = (data: unknown[], url: string) => new Response(JSON.stringify({ object: "list", data, has_more: false, url }), { status: 200 });

// The clock the pass and the in-memory Redis both read, moved by the test.
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response(JSON.stringify({ error: "nothing leaves this test" }), { status: 500 });
  const path = url.pathname.replace(/^\/v1/, "");
  const q = url.searchParams;
  if (path === "/refunds") {
    const charge = q.get("charge");
    if (charge) return listOf(refunds.filter((r) => r.charge.id === charge), "/v1/refunds");
    refundPages += 1;
    const since = Number(q.get("created[gte]") ?? 0);
    return listOf(refunds.filter((r) => r.created >= since).sort((a, b) => b.created - a.created), "/v1/refunds");
  }
  if (path === "/events") return listOf([], "/v1/events");
  if (path === "/checkout/sessions") {
    const pi = q.get("payment_intent");
    if (pi) return listOf(sessions.filter((s) => s.payment_intent.id === pi), "/v1/checkout/sessions");
    const email = q.get("customer_details[email]");
    if (email && unreadable.has(email)) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
    if (email) return listOf(sessions.filter((s) => s.customer_details.email === email), "/v1/checkout/sessions");
    return listOf([], "/v1/checkout/sessions");
  }
  if (path.startsWith("/payment_intents/")) return new Response(JSON.stringify({ id: path.split("/")[2], object: "payment_intent", metadata: {} }), { status: 200 });
  return listOf([], path);
}) as typeof fetch;

const hoursAgo = (n: number) => Math.floor(Date.now() / 1000) - n * 3_600;
let n = 0;
function buy(handle: string, email: string, product: string): Session {
  n += 1;
  const tag = String(n).padStart(10, "0");
  const charge: Charge = { object: "charge", id: `ch_pace${tag}`, amount: 4900, amount_refunded: 0, refunded: false, disputed: false };
  const session: Session = {
    id: `cs_test_pace${tag}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: hoursAgo(5),
    customer_details: { email },
    metadata: { store: handle, product },
    payment_intent: { id: `pi_pace${tag}`, object: "payment_intent", latest_charge: charge },
  };
  sessions.push(session);
  return session;
}
/** A full refund that succeeded two hours ago, older than the pass's wait. */
function refundInFull(session: Session): Refund {
  n += 1;
  const charge = session.payment_intent.latest_charge;
  charge.amount_refunded = charge.amount;
  charge.refunded = true;
  const row: Refund = { id: `re_pace${String(n).padStart(10, "0")}`, object: "refund", created: hoursAgo(2), status: "succeeded", amount: charge.amount, payment_intent: session.payment_intent.id, charge };
  refunds.push(row);
  return row;
}

async function storeWith(owner: string, handle: string, account: string): Promise<{ store: Store; product: string; courseId: string }> {
  await claimHandle(owner, handle, `School ${handle}`, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, account, true);
  const made = await addProduct(owner, "A course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const courseId = `${handle.length.toString(16)}0000`.padEnd(32, "d");
  await setProductCourse(owner, made.product.id, { id: courseId, lessons: 3 });
  return { store: (await storeForEmail(owner))!, product: made.product.id, courseId };
}

async function main(): Promise<void> {
  redis.clear();
  const exported = pass as unknown as Record<string, unknown>;
  const publicName = (certificates as unknown as { publicName: (c: Certificate) => string | null }).publicName;
  const record = async (id: string) => (await readCertificate(id)) as Certificate | null;
  const shop = await storeWith("pace@example.com", "paceschool", "acct_1TestPaceSchool");
  const issue = async (email: string, name: string) => {
    const course = { id: shop.courseId, certificate: true, startsAt: null, modules: [] } as unknown as Course;
    const issued = await issueCertificate({ store: storeKey(shop.store), productId: shop.product, course, title: "A course", creator: "A school", email, who: emailKey(email), name, room: { ...ROOM, statsId: shop.store.statsId } });
    if (!issued.ok) throw new Error("not issued");
    return issued.certificate.id;
  };
  const run = () => pass.withdrawRefundedCertificates(shop.store, Date.now() + 60_000).catch(() => -1);
  const raw = exported.CERTIFICATE_REFUND_CHECKS_PER_MONTH;
  const ceilingOf = (store: Store): number => (typeof raw === "number" ? raw : (raw as Record<string, number>)[store.tier]);
  const counter = () => `nl:certrefunds:n:${shop.store.statsId}:${new Date(Date.now()).toISOString().slice(0, 7)}`;
  const checksTaken = async () => Number((await redis.pipeline([["GET", counter()]]))[0] ?? 0);

  part("ALTO 2: the Store plan's first year given back stays under the US$ 65 the owner keeps, with the pass priced");
  {
    // As tests/plan-margin.test.ts and tests/read-ceilings.test.ts work it out.
    const kept = (paidStorageBytes("creator") / GB) * STORAGE_PER_GB * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30);
    const year = worstCost("creator") + providerFeeUsd(PRICES_WITHOUT_COMMISSION.creator.year) + kept;
    is(`the first year given back is under US$ 65 (US$ ${year.toFixed(2)})`, year < 65, true);
  }

  part("ALTO 2: the sweep runs a store's pass at most once every CERTIFICATE_PASS_EVERY_SECONDS");
  const every = exported.CERTIFICATE_PASS_EVERY_SECONDS;
  is("the pace is a named, exported time of at least an hour", typeof every === "number" && every >= 3_600, true);
  const pace = typeof every === "number" ? every : 7_200;
  await issue("ivy@example.com", "Ivy Example");
  await sweepCheckouts(Date.now() + 20_000);
  const first = refundPages;
  is("the first sweep reads the store's refunds", first > 0, true);
  await sweepCheckouts(Date.now() + 20_000);
  is("a sweep five minutes later reads no page of them", refundPages, first);
  shift += (pace + 60) * 1_000;
  await sweepCheckouts(Date.now() + 20_000);
  is("once the pace has passed, the next sweep reads them again", refundPages > first, true);

  part("L2: a run's priced commands count the INCRBY and EXPIRE it sends once the month's checks are spent");
  // The head's enumerated parts of a run (the mark's GET, the place's GET, the lost disputes' place GET and its SET or
  // DEL, a read of the rows handled for them, one a page, one to keep their place, the place's SET and trim), and two.
  is("CERTIFICATE_PASS_RUN_COMMANDS has room for the two commands past the ceiling", CERTIFICATE_PASS_RUN_COMMANDS >= 1 + 1 + 2 + 1 + CERTIFICATE_REFUND_PAGES_PER_STORE + 1 + 2 + 2, true);

  part("MÉDIO 2: a row whose buyer's courses cannot be read takes its checks once, not on every run");
  const ceiling = ceilingOf(shop.store);
  is("the month's checks are a ceiling above three", ceiling > 3, true);
  await redis.pipeline([["SET", counter(), String(ceiling - 3), "EX", 40 * 86_400]]);
  const stuck = buy("paceschool", "stuck@example.com", shop.product);
  const stuckId = await issue("stuck@example.com", "Stuck Example");
  refundInFull(stuck);
  unreadable.add("stuck@example.com");
  for (let i = 0; i < 12; i += 1) await run();
  is("twelve runs on a row left unknown take its one course's check once", await checksTaken(), ceiling - 2);
  is("unknown never withdraws: the certificate still stands", ((await record(stuckId))?.withdrawnAt ?? 0) > 0, false);
  const zoe = buy("paceschool", "zoe@example.com", shop.product);
  const zoeId = await issue("zoe@example.com", "Zoe Example");
  refundInFull(zoe);
  for (let i = 0; i < 2; i += 1) await run();
  is("a healthy full refund after it still withdraws its certificate (no name on the page)", publicName((await record(zoeId))!), null);
  is("the row left unknown still stands", ((await record(stuckId))?.withdrawnAt ?? 0) > 0, false);
  unreadable.delete("stuck@example.com");
  await redis.pipeline([["DEL", counter()]]);
  const retry = exported.CERTIFICATE_REFUND_RETRY_SECONDS;
  is("the wait before a row left unknown is tried again is a named, exported time", typeof retry === "number" && retry > 0, true);
  shift += ((typeof retry === "number" ? retry : 86_400) + 60) * 1_000;
  for (let i = 0; i < 2; i += 1) await run();
  is("once its buyer's courses read, it is tried again and withdrawn: never forgotten", publicName((await record(stuckId))!), null);

  part("L1: the privacy policy says a withdrawal can wait until the next month");
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the certificates' paragraph names the next month", /refunded in full or lost in a dispute is withdrawn[^.]*next month/.test(privacy), true);

  Date.now = realNow;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
