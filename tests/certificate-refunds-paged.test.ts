/**
 * The certificates' refund pass reads every refund, a bounded page at a time (review of #3409, Claude 3: M1, M2, L1-L4).
 *
 * lib/certificate-refunds.ts read every refund since its place in one go, at most three pages of a hundred: past that
 * it handled no row at all and kept its place, so the next run read the same newest pages again, and once its place
 * expired the older refunds were never read. Now it reads at most CERTIFICATE_REFUND_PAGES_PER_STORE pages a run from
 * where the last run stopped (the place keeps the last row dealt with), handles every row it reads, and the place moves
 * only once the refunds are read to their end, held at the oldest row that was not handled.
 *
 * What is checked, against a stand-in for Stripe that pages as Stripe does (limit, starting_after, has_more):
 *   - M1: a certificate whose refund is older than more than 300 other full refunds is withdrawn within a bounded
 *     number of runs; the place is written again on every run, so it never expires into a skip;
 *   - an unreadable refund row withdraws nothing and holds the place at or before its own time, while the rows behind
 *     it are still handled; once it reads, its certificate goes;
 *   - L1: a refund younger than the time a kept answer about the buyer's courses lives (plus a margin) is not acted on
 *     yet, so a certificate issued from such a kept answer is withdrawn too; it is acted on once it is older;
 *   - L3: the rows handled are kept by their time and trimmed below the place once the refunds are read to their end;
 *   - M2: the pages and lookups are priced in tests/plan-cost-registry.ts (per plan since the second review of #3409,
 *     line certificate-refund-pass), and LOST_DISPUTE_PAGES names six jobs;
 *   - L2: the privacy policy and the pass say that a course paid through PayPal is not covered;
 *   - L4: the pass has a time slice of its own inside the sweep's deadline.
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { readFileSync } from "node:fs";
import * as pass from "@/lib/certificate-refunds";
import { type Certificate, issueCertificate, readCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { COST_LINES, NOT_A_COST } from "./plan-cost-registry";

process.env.STRIPE_SECRET_KEY = "sk_test_certificate_refunds_paged";

const OWNER = "pager@example.com";
const HANDLE = "pagedschool";
const ACCOUNT = "acct_1TestCertPaged";
const COURSE_ID = "d".repeat(32);

type Charge = { object: "charge"; id: string; amount: number; amount_refunded: number; refunded: boolean; disputed: boolean };
type Refund = { id: string; object: "refund"; created: number; status: string; amount: number; payment_intent: string; charge: Charge };
type Session = Record<string, unknown> & { id: string; created: number; customer_details: { email: string }; payment_intent: { id: string; object: "payment_intent"; latest_charge: Charge } };

const sessions: Session[] = [];
const refunds: Refund[] = [];
/** Refund ids Stripe answers in a shape that cannot be read (no status). */
const garbled = new Set<string>();
let refundListCalls = 0;

const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;
let clock = Math.floor(realNow() / 1000) - 6 * 3_600;
// The students below bought hours ago; their refunds are made when each part says.
const tick = () => (clock += 5);

const listOf = (data: unknown[], hasMore: boolean, url: string) => new Response(JSON.stringify({ object: "list", data, has_more: hasMore, url }), { status: 200 });

/** Stripe's paging: newest first, `limit` rows, from after `starting_after`, has_more when rows are left. */
function paged<T extends { id: string; created: number }>(rows: T[], q: URLSearchParams, present: (row: T) => unknown, url: string): Response {
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 10)));
  let sorted = [...rows].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
  const after = q.get("starting_after");
  if (after) {
    const at = sorted.findIndex((row) => row.id === after);
    if (at < 0) return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such refund" } }), { status: 400 });
    sorted = sorted.slice(at + 1);
  }
  return listOf(sorted.slice(0, limit).map(present), sorted.length > limit, url);
}

const present = (row: Refund) => (garbled.has(row.id) ? { id: row.id, object: "refund", created: row.created, amount: row.amount, charge: row.charge, payment_intent: row.payment_intent } : row);

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response(JSON.stringify({ error: "nothing leaves this test" }), { status: 500 });
  const path = url.pathname.replace(/^\/v1/, "");
  const q = url.searchParams;
  if (path === "/refunds") {
    const charge = q.get("charge");
    if (charge) return paged(refunds.filter((r) => r.charge.id === charge), q, present, "/v1/refunds");
    refundListCalls += 1;
    const since = Number(q.get("created[gte]") ?? 0);
    return paged(refunds.filter((r) => r.created >= since), q, present, "/v1/refunds");
  }
  if (path === "/events") return listOf([], false, "/v1/events");
  if (path === "/checkout/sessions") {
    const pi = q.get("payment_intent");
    if (pi) return listOf(sessions.filter((s) => s.payment_intent.id === pi), false, "/v1/checkout/sessions");
    const email = q.get("customer_details[email]");
    if (email) return listOf(sessions.filter((s) => s.customer_details.email === email), false, "/v1/checkout/sessions");
    return listOf([], false, "/v1/checkout/sessions");
  }
  if (path.startsWith("/payment_intents/")) return new Response(JSON.stringify({ id: path.split("/")[2], object: "payment_intent", metadata: {} }), { status: 200 });
  return listOf([], false, path);
}) as typeof fetch;

let n = 0;
function buy(email: string, product: string): Session {
  n += 1;
  const tag = String(n).padStart(10, "0");
  const charge: Charge = { object: "charge", id: `ch_page${tag}`, amount: 4900, amount_refunded: 0, refunded: false, disputed: false };
  const session: Session = {
    id: `cs_test_page${tag}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: tick(),
    customer_details: { email },
    metadata: { store: HANDLE, product },
    payment_intent: { id: `pi_page${tag}`, object: "payment_intent", latest_charge: charge },
  };
  sessions.push(session);
  return session;
}

/** A full refund of the session's charge that succeeded, made at `at` (seconds) or now on the test's clock. */
function refundInFull(session: Session, at = tick()): Refund {
  n += 1;
  const charge = session.payment_intent.latest_charge;
  charge.amount_refunded = charge.amount;
  charge.refunded = true;
  const row: Refund = { id: `re_page${String(n).padStart(10, "0")}`, object: "refund", created: at, status: "succeeded", amount: charge.amount, payment_intent: session.payment_intent.id, charge };
  refunds.push(row);
  return row;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Paged School", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Paged Basics", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductCourse(OWNER, made.product.id, { id: COURSE_ID, lessons: 3 });
  const store = (await storeForEmail(OWNER))!;
  const product = made.product.id;
  const sid = store.statsId!;
  const course = { id: COURSE_ID, certificate: true, startsAt: null, modules: [] } as unknown as Course;
  const anchorKey = `nl:certrefunds:since:${sid}`;
  const seenKey = `nl:certrefunds:seen:${sid}`;
  const exported = pass as unknown as Record<string, unknown>;
  const run = () => pass.withdrawRefundedCertificates(store, Date.now() + 60_000);
  const anchorAt = async (): Promise<number> => Number(String((await redis.pipeline([["GET", anchorKey]]))[0] ?? "").split("|")[0]);

  const student = async (email: string): Promise<{ session: Session; id: string }> => {
    const session = buy(email, product);
    const issued = await issueCertificate({ store: storeKey(store), productId: product, course, title: "Paged Basics", creator: "Paged School", email, who: emailKey(email), name: `Student ${email.split("@")[0]}`, room: ROOM });
    if (!issued.ok) throw new Error("not issued");
    return { session, id: issued.certificate.id };
  };
  const withdrawn = async (id: string): Promise<boolean> => (((await readCertificate(id)) as Certificate | null)?.withdrawnAt ?? 0) > 0;

  part("L1: a refund younger than a kept answer's life is acted on only once it is older");
  const settle = exported.CERTIFICATE_REFUND_SETTLE_SECONDS;
  is("the wait is named and longer than the ten minutes a kept answer lives", typeof settle === "number" && settle > 600, true);
  const wes = await student("wes@example.com");
  const recent = refundInFull(wes.session, Math.floor(Date.now() / 1000) - 60);
  for (let i = 0; i < 2; i += 1) await run().catch(() => 0);
  is("refunded a minute ago: the certificate still stands (a kept answer may still say the course opens)", await withdrawn(wes.id), false);
  is("the place waits at that refund", (await anchorAt()) <= recent.created, true);
  offsetMs = ((typeof settle === "number" ? settle : 900) + 120) * 1000;
  for (let i = 0; i < 2; i += 1) await run().catch(() => 0);
  is("once the refund is older than the wait: withdrawn", await withdrawn(wes.id), true);
  // From here on the clock reads three hours on, and the refunds below are made from now: each is older than the wait.
  offsetMs = 3 * 3_600_000;
  clock = Math.floor(realNow() / 1000);


  part("M1: more than 300 full refunds since the place: every one is read, a bounded page at a time");
  const zoe = await student("zoe@example.com");
  refundInFull(zoe.session);
  for (let i = 0; i < 320; i += 1) refundInFull(buy(`other${i}@example.com`, product));
  const pages = exported.CERTIFICATE_REFUND_PAGES_PER_STORE;
  const lookups = exported.CERTIFICATE_REFUND_LOOKUPS_PER_STORE;
  is("the pages a run reads are a named, exported ceiling", pages, 3);
  is("the lookups a run makes are a named, exported ceiling", lookups, 20);
  let runs = 0;
  let pagesMost = 0;
  let ttlLeast = Infinity;
  for (; runs < 60 && !(await withdrawn(zoe.id)); runs += 1) {
    const before = refundListCalls;
    await run().catch(() => 0);
    pagesMost = Math.max(pagesMost, refundListCalls - before);
    ttlLeast = Math.min(ttlLeast, Number((await redis.pipeline([["TTL", anchorKey]]))[0]));
    if (runs === 0) redis.advance(13 * 86_400_000);
  }
  is("Zoe's certificate, behind 320 other full refunds, is withdrawn within 25 runs", [await withdrawn(zoe.id), runs <= 25], [true, true]);
  is("no run reads more than CERTIFICATE_REFUND_PAGES_PER_STORE pages of refunds", pagesMost <= 3, true);
  is("the place is written again on every run, so it never expires into a skip", ttlLeast > 13 * 86_400, true);
  for (let i = 0; i < 3; i += 1) await run();
  is("read to the end: the place moved past the refunds handled", (await anchorAt()) >= zoe.session.created, true);

  part("L3: the rows handled are kept by their time and trimmed below the place");
  const type = (await redis.pipeline([["TYPE", seenKey]]))[0];
  is("the rows handled are a sorted set by time", type, "zset");
  const below = type === "zset" ? Number((await redis.pipeline([["ZCOUNT", seenKey, "-inf", String((await anchorAt()) - 301)]]))[0]) : -1;
  is("none kept below the place once the refunds were read to their end", below, 0);

  part("An unreadable refund holds the place at its own time, and the rows behind it are still handled");
  const yan = await student("yan@example.com");
  refundInFull(yan.session);
  const xia = await student("xia@example.com");
  const xiaRefund = refundInFull(xia.session);
  garbled.add(xiaRefund.id);
  for (let i = 0; i < 3; i += 1) await run().catch(() => 0);
  is("Yan's refund, behind the unreadable one, still withdraws his certificate", await withdrawn(yan.id), true);
  is("Xia's refund cannot be read: her certificate stands", await withdrawn(xia.id), false);
  is("the place holds at or before the unreadable refund", (await anchorAt()) <= xiaRefund.created, true);
  garbled.delete(xiaRefund.id);
  for (let i = 0; i < 3; i += 1) await run().catch(() => 0);
  is("once it reads, Xia's certificate goes", await withdrawn(xia.id), true);

  part("A place whose row Stripe no longer knows is read again from the newest, never left stuck");
  const at = await anchorAt();
  await redis.pipeline([["SET", anchorKey, `${at}|re_gone0000000000000000000|${at}|0`, "EX", 86_400]]);
  await run().catch(() => 0);
  is("the row to read on after is dropped, the place itself kept", String((await redis.pipeline([["GET", anchorKey]]))[0]), String(at));
  const vic = await student("vic@example.com");
  refundInFull(vic.session);
  await run().catch(() => 0);
  is("the next pass reads from the newest again: a new full refund withdraws its certificate", await withdrawn(vic.id), true);

  part("M2: what the pass costs is in the registry");
  const registry = NOT_A_COST as Record<string, string | undefined>;
  for (const name of ["CERTIFICATE_REFUND_LOOKBACK_SECONDS", "CERTIFICATE_REFUND_SETTLE_SECONDS", "CERTIFICATE_REFUND_PASS_MS"]) {
    is(`${name} is exported by the pass and cited in NOT_A_COST`, [name in exported, typeof registry[name] === "string" && registry[name]!.includes("lib/certificate-refunds.ts")], [true, true]);
  }
  // Since the second review of #3409 (Claude 5, ALTO 1) the pages and lookups are priced per plan in COST_LINES
  // (tests/certificate-refund-pass-cost.test.ts holds that line).
  const passLine = COST_LINES.find((line) => line.id === "certificate-refund-pass");
  const names = passLine?.sources.flatMap((source) => source.names) ?? [];
  is("the pages and lookups are exported by the pass and cited by its plan line", ["CERTIFICATE_REFUND_PAGES_PER_STORE", "CERTIFICATE_REFUND_LOOKUPS_PER_STORE"].map((name) => name in exported && names.includes(name)), [true, true]);
  const basis = passLine?.basis ?? "";
  is("each run's and each row's commands are priced: the runs, the month's checks and each check's commands", ["CERTIFICATE_PASS_RUN_COMMANDS", "CERTIFICATE_REFUND_CHECKS_PER_MONTH", "CERTIFICATE_PASS_CHECK_COMMANDS"].every((word) => basis.includes(word)), true);
  is("LOST_DISPUTE_PAGES names six jobs, the certificates' pass among them", /six five-minute jobs/.test(NOT_A_COST.LOST_DISPUTE_PAGES) && /6 x LOST_DISPUTE_PAGES/.test(NOT_A_COST.LOST_DISPUTE_PAGES) && /lib\/certificate-refunds\.ts/.test(NOT_A_COST.LOST_DISPUTE_PAGES), true);

  part("L2: a course paid through PayPal is not covered, and the texts say so");
  const source = readFileSync("lib/certificate-refunds.ts", "utf8");
  is("the pass says PayPal is not covered", /Not here:[\s\S]{0,400}PayPal/.test(source), true);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the privacy policy says a certificate of a course paid through PayPal is withdrawn by the creator", /certificate of a course paid through PayPal[^.]*withdrawn by the creator/.test(privacy), true);
  is("the privacy policy no longer promises minutes", /withdrawn on its own within minutes/.test(privacy), false);

  part("L4: the pass has a time slice of its own");
  is("CERTIFICATE_REFUND_PASS_MS is at most four seconds", typeof exported.CERTIFICATE_REFUND_PASS_MS === "number" && (exported.CERTIFICATE_REFUND_PASS_MS as number) <= 4_000, true);
  is("the pass stops at the sooner of the sweep's deadline and its slice", /Math\.min\(deadline, Date\.now\(\) \+ CERTIFICATE_REFUND_PASS_MS\)/.test(source), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
