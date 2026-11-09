/**
 * The certificates' refund pass works only where a certificate was issued, and a full refund takes the name off every
 * certificate of the course the student was issued (second review of #3409, Claude 5: ALTO 1, MÉDIO 1).
 *
 * ALTO 1: every run of the five-minute sweep read every course listing and one count a course of every store paid
 * through Stripe with a course, before knowing whether any certificate was issued: a run's work grew with the courses
 * (MAX_PRODUCTS), and it was booked as a company fixed cost. Now a store's mark, written when a certificate is issued
 * (and by a one-time look at the courses' counts for those issued before the mark was kept, repeated while none is
 * found), says whether the pass has anything to do; a store with no certificate costs one read a run, whatever its
 * courses. What the pass costs a store that issued one is priced per plan in COST_LINES.
 *
 * MÉDIO 1: a certificate the creator had already withdrawn by hand (or an earlier one, replaced since) kept the
 * student's name on its page after a full refund. Now the refund marks every certificate of the course the student
 * was issued as withdrawn for a refund, keeping when it was withdrawn.
 *
 * What is checked:
 *   - a run on a store with 2 courses and on one with 120, none of which issued a certificate, sends the same
 *     commands, at most one, and asks Stripe nothing; its worst month is a few cents;
 *   - issuing a certificate sets the store's mark at once, and the pass then reads the refunds;
 *   - a mark that reads in another shape runs the pass (never skips it);
 *   - a certificate issued before the mark was kept is found by the look at the courses, repeated once the "none
 *     found" mark expires, sooner than the pass's first look back, and its full refund withdraws it;
 *   - a certificate withdrawn by hand, then fully refunded, shows no name; an earlier one replaced since shows no
 *     name either; a hand-withdrawn one with no refund keeps it (control); running again changes nothing;
 *   - past the month's checks the pass waits at the row and takes it up the next month, never skipping it;
 *   - the pass's ceilings are priced per plan in COST_LINES, not as a company fixed cost.
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import * as pass from "@/lib/certificate-refunds";
import * as certificates from "@/lib/certificate";
import { type Certificate, issueCertificate, readCertificate, withdrawCertificate } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { type Store, addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { emailKey, storeKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { CERTIFICATE_PASS_CHECK_COMMANDS, CERTIFICATE_PASS_RUNS, CERTIFICATE_PASS_RUN_COMMANDS, COMMAND, COST_LINES, NOT_A_COST } from "./plan-cost-registry";

process.env.STRIPE_SECRET_KEY = "sk_test_certificate_refund_pass_cost";

type Charge = { object: "charge"; id: string; amount: number; amount_refunded: number; refunded: boolean; disputed: boolean };
type Refund = { id: string; object: "refund"; created: number; status: string; amount: number; payment_intent: string; charge: Charge };
type Session = Record<string, unknown> & { id: string; created: number; customer_details: { email: string }; payment_intent: { id: string; object: "payment_intent"; latest_charge: Charge } };

const sessions: Session[] = [];
const refunds: Refund[] = [];
let stripeCalls = 0;

const listOf = (data: unknown[], url: string) => new Response(JSON.stringify({ object: "list", data, has_more: false, url }), { status: 200 });

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response(JSON.stringify({ error: "nothing leaves this test" }), { status: 500 });
  stripeCalls += 1;
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

// Every command sent to Redis is counted; a reply may be replaced for one key.
let commands = 0;
const healthy = redis.pipeline;
const replaced = new Map<string, unknown>();
redis.pipeline = async (batch: (string | number)[][]) => {
  commands += batch.length;
  const replies = await healthy(batch);
  return replies.map((reply, i) => (batch[i][0] === "GET" && replaced.has(String(batch[i][1])) ? replaced.get(String(batch[i][1])) : reply));
};

const hours = (n: number) => Math.floor(Date.now() / 1000) - n * 3_600;
let n = 0;
function buy(handle: string, email: string, product: string): Session {
  n += 1;
  const tag = String(n).padStart(10, "0");
  const charge: Charge = { object: "charge", id: `ch_cost${tag}`, amount: 4900, amount_refunded: 0, refunded: false, disputed: false };
  const session: Session = {
    id: `cs_test_cost${tag}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: hours(5),
    customer_details: { email },
    metadata: { store: handle, product },
    payment_intent: { id: `pi_cost${tag}`, object: "payment_intent", latest_charge: charge },
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
  const row: Refund = { id: `re_cost${String(n).padStart(10, "0")}`, object: "refund", created: hours(2), status: "succeeded", amount: charge.amount, payment_intent: session.payment_intent.id, charge };
  refunds.push(row);
  return row;
}

async function storeWith(owner: string, handle: string, account: string, courses: number): Promise<{ store: Store; products: string[]; courseIds: string[] }> {
  await claimHandle(owner, handle, `School ${handle}`, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, account, true);
  const products: string[] = [];
  const courseIds: string[] = [];
  for (let i = 0; i < courses; i += 1) {
    const made = await addProduct(owner, `Course ${i + 1}`, "", "49", null);
    if (!made.ok) throw new Error(`no product ${i}`);
    const id = `${handle.length.toString(16)}${String(i).padStart(4, "0")}`.padEnd(32, "e");
    await setProductCourse(owner, made.product.id, { id, lessons: 3 });
    products.push(made.product.id);
    courseIds.push(id);
  }
  return { store: (await storeForEmail(owner))!, products, courseIds };
}

async function main(): Promise<void> {
  redis.clear();
  const exported = pass as unknown as Record<string, unknown>;
  const publicName = (certificates as unknown as { publicName: (c: Certificate) => string | null }).publicName;
  const two = await storeWith("two@example.com", "twocourses", "acct_1TestCostTwo", 2);
  const many = await storeWith("many@example.com", "manycourses", "acct_1TestCostMany", 120);
  const run = async (store: Store) => {
    const before = [commands, stripeCalls];
    const withdrawn = await pass.withdrawRefundedCertificates(store, Date.now() + 60_000).catch(() => -1);
    return { withdrawn, commands: commands - before[0], stripe: stripeCalls - before[1] };
  };
  const issue = async (store: Store, productId: string, courseId: string, email: string, name: string, room = { ...ROOM, statsId: store.statsId }) => {
    const course = { id: courseId, certificate: true, startsAt: null, modules: [] } as unknown as Course;
    const issued = await issueCertificate({ store: storeKey(store), productId, course, title: "A course", creator: "A school", email, who: emailKey(email), name, room });
    if (!issued.ok) throw new Error("not issued");
    return issued.certificate.id;
  };
  const record = async (id: string) => (await readCertificate(id)) as Certificate | null;
  const markOf = async (store: Store) => (await healthy([["GET", `nl:certrefunds:has:${store.statsId}`]]))[0];

  part("ALTO 1: a store none of whose courses issued a certificate costs the same small read a run, whatever its courses");
  await run(two.store);
  await run(many.store);
  const small = await run(two.store);
  const large = await run(many.store);
  is("a run's commands do not grow with the courses (2 courses, 120 courses)", large.commands, small.commands);
  is("at most one command a run, and nothing asked of Stripe", [small.commands <= 1, small.stripe + large.stripe], [true, 0]);
  is("such a store's worst month of runs costs under two cents", small.commands * CERTIFICATE_PASS_RUNS * COMMAND < 0.02, true);

  part("A mark that reads in another shape runs the pass, never skips it");
  replaced.set(`nl:certrefunds:has:${many.store.statsId}`, 7);
  const odd = await run(many.store);
  replaced.clear();
  is("the pass read the refunds", odd.stripe > 0, true);

  part("Issuing a certificate sets the store's mark at once, and the pass reads the refunds from then on");
  const ana = buy("twocourses", "ana@example.com", two.products[0]);
  const anaId = await issue(two.store, two.products[0], two.courseIds[0], "ana@example.com", "Ana Example");
  is("the mark is set by the issue", await markOf(two.store), "1");
  refundInFull(ana);
  const after = await run(two.store);
  is("the pass reads the refunds and withdraws Ana's certificate", [after.stripe > 0, ((await record(anaId))?.withdrawnAt ?? 0) > 0], [true, true]);
  const idle = await run(two.store);
  is("a run with no row to look up stays within CERTIFICATE_PASS_RUN_COMMANDS", idle.commands <= CERTIFICATE_PASS_RUN_COMMANDS, true);
  // Ana's lookup took two checks: the one course her checkout gave, and her row once marked handled.
  is("a lookup that withdraws a certificate stays within CERTIFICATE_PASS_CHECK_COMMANDS a check", after.commands - idle.commands <= 2 * CERTIFICATE_PASS_CHECK_COMMANDS, true);
  const month = new Date().toISOString().slice(0, 7);
  is("each course checked and each row marked handled takes one of the month's checks", (await healthy([["GET", `nl:certrefunds:n:${two.store.statsId}:${month}`]]))[0], "2");
  console.log(`  (measured: a run ${idle.commands} commands, a lookup ${after.commands - idle.commands})`);

  part("A certificate issued before the mark was kept is found by the look at the courses");
  const scan = exported.CERTIFICATE_SCAN_SECONDS;
  is("the look is repeated sooner than the pass's first look back, less its wait", typeof scan === "number" && scan + (exported.CERTIFICATE_REFUND_SETTLE_SECONDS as number) < (exported.CERTIFICATE_REFUND_LOOKBACK_SECONDS as number), true);
  const ben = buy("manycourses", "ben@example.com", many.products[117]);
  // Issued as before the mark was kept: its room names no store id, so the mark is not set.
  const benId = await issue(many.store, many.products[117], many.courseIds[117], "ben@example.com", "Ben Example", { ...ROOM, statsId: null });
  refundInFull(ben);
  is("the store's mark still says none found", await markOf(many.store), "0");
  redis.advance(((typeof scan === "number" ? scan : 6 * 86_400) + 60) * 1_000);
  await run(many.store);
  await run(many.store);
  is("once the mark of none expires, the look finds the certificate and sets the mark", await markOf(many.store), "1");
  is("and the full refund withdraws it", ((await record(benId))?.withdrawnAt ?? 0) > 0, true);

  part("MÉDIO 1: a full refund takes the name off a certificate already withdrawn by hand, and off an earlier one");
  const [course, product] = [two.courseIds[1], two.products[1]];
  const cleo = buy("twocourses", "cleo@example.com", product);
  const cleoId = await issue(two.store, product, course, "cleo@example.com", "Cleo Example");
  refundInFull(cleo);
  await withdrawCertificate(course, cleoId);
  const cleoAt = (await record(cleoId))!.withdrawnAt;
  const dan = buy("twocourses", "dan@example.com", product);
  const danOld = await issue(two.store, product, course, "dan@example.com", "Dan Example");
  await withdrawCertificate(course, danOld);
  const danNew = await issue(two.store, product, course, "dan@example.com", "Daniel Example");
  refundInFull(dan);
  const eve = buy("twocourses", "eve@example.com", product);
  const eveId = await issue(two.store, product, course, "eve@example.com", "Eve Example");
  await withdrawCertificate(course, eveId);
  void eve;
  for (let i = 0; i < 3; i += 1) await run(two.store);
  const cleoNow = (await record(cleoId))!;
  is("withdrawn by hand, then refunded in full: no name on the page", publicName(cleoNow), null);
  is("when it was withdrawn is kept", cleoNow.withdrawnAt, cleoAt);
  is("refunded in full: neither Dan's standing certificate nor his earlier one shows his name", [publicName((await record(danNew))!), publicName((await record(danOld))!)], [null, null]);
  is("withdrawn by hand with no refund: the name stays (control)", publicName((await record(eveId))!), "Eve Example");
  const again = JSON.stringify(await Promise.all([cleoId, danOld, danNew, eveId].map(record)));
  for (let i = 0; i < 2; i += 1) await run(two.store);
  is("running again changes nothing", JSON.stringify(await Promise.all([cleoId, danOld, danNew, eveId].map(record))), again);

  part("Past the month's checks the pass waits at the row, and goes on from it the next month");
  const ceiling = exported.CERTIFICATE_REFUND_CHECKS_PER_MONTH;
  is("the month's checks are a named, exported ceiling", typeof ceiling === "number" && ceiling > 0, true);
  const counter = `nl:certrefunds:n:${two.store.statsId}:${new Date().toISOString().slice(0, 7)}`;
  await healthy([["SET", counter, String(ceiling), "EX", 3_600]]);
  const fay = buy("twocourses", "fay@example.com", two.products[0]);
  const fayId = await issue(two.store, two.products[0], two.courseIds[0], "fay@example.com", "Fay Example");
  refundInFull(fay);
  for (let i = 0; i < 2; i += 1) await run(two.store);
  is("the checks spent: Fay's certificate still stands, nothing read for it", ((await record(fayId))?.withdrawnAt ?? 0) > 0, false);
  await healthy([["DEL", counter]]);
  for (let i = 0; i < 2; i += 1) await run(two.store);
  is("a new month's checks: her full refund withdraws it (the row was not skipped)", publicName((await record(fayId))!), null);

  part("What the pass costs a store that issued a certificate is priced per plan");
  const line = COST_LINES.find((one) => one.id === "certificate-refund-pass");
  is("a plan's line prices the pass", Boolean(line), true);
  is("the line names the pass's ceilings", Boolean(line?.sources.some((s) => s.file === "lib/certificate-refunds.ts" && ["CERTIFICATE_REFUND_PAGES_PER_STORE", "CERTIFICATE_REFUND_LOOKUPS_PER_STORE"].every((name) => s.names.includes(name)))), true);
  is("the line has a figure above zero for a paid plan", (line?.monthlyUsd("creator") ?? 0) > 0, true);
  console.log(`  (the line: $${(line?.monthlyUsd("creator") ?? 0).toFixed(4)} a store a month)`);
  const registry = NOT_A_COST as Record<string, string | undefined>;
  is("the pages and lookups are no longer a company fixed cost", ["CERTIFICATE_REFUND_PAGES_PER_STORE", "CERTIFICATE_REFUND_LOOKUPS_PER_STORE"].some((name) => name in registry), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
