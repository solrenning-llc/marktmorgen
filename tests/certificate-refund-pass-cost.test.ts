/**
 * The certificates' refund pass works only where a certificate was issued, and a full refund takes the name off every
 * certificate of the course the student was issued (second review of #3409, Claude 5: ALTO 1, MÉDIO 1).
 *
 * ALTO 1: every run of the five-minute sweep read every course listing and one count a course of every store paid
 * through Stripe with a course, before knowing whether any certificate was issued: a run's work grew with the courses
 * (MAX_PRODUCTS), and it was booked as a company fixed cost. Now a pass reads no course but those a refunded checkout
 * gave, so its commands do not grow with the courses; it runs on the store's turn, at most once every
 * CERTIFICATE_PASS_EVERY_SECONDS (focal review, ALTO 2: tests/certificate-refund-pass-pace.test.ts), and what it
 * costs a store is priced per plan in COST_LINES.
 *
 * MÉDIO 1: a certificate the creator had already withdrawn by hand (or an earlier one, replaced since) kept the
 * student's name on its page after a full refund. Now the refund marks every certificate of the course the student
 * was issued as withdrawn for a refund, keeping when it was withdrawn.
 *
 * What is checked:
 *   - a pass on a store with 2 courses and on one with 120 sends the same commands, within
 *     CERTIFICATE_PASS_RUN_COMMANDS;
 *   - the sweep's turns: one MGET for the batch; a turn absent is due, one taken is not; a reply in another shape runs
 *     no pass that run; a turn is taken once, with SET NX EX, and held CERTIFICATE_PASS_EVERY_SECONDS;
 *   - a refund withdraws its certificate, and one issued with no store id on its room is met by its refund all the same;
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
import { CERTIFICATE_PASS_CHECK_COMMANDS, CERTIFICATE_PASS_RUN_COMMANDS, COST_LINES, NOT_A_COST } from "./plan-cost-registry";

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
  return replies.map((reply, i) => (batch[i][0] === "GET" && replaced.has(String(batch[i][1])) ? replaced.get(String(batch[i][1])) : batch[i][0] === "MGET" && replaced.has("MGET") ? replaced.get("MGET") : reply));
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
  const turnOf = async (store: Store) => (await healthy([["GET", `nl:certrefunds:next:${store.statsId}`]]))[0];

  part("ALTO 1: a pass's commands do not grow with the store's courses");
  await run(two.store);
  await run(many.store);
  const small = await run(two.store);
  const large = await run(many.store);
  is("a pass's commands do not grow with the courses (2 courses, 120 courses)", large.commands, small.commands);
  is("within CERTIFICATE_PASS_RUN_COMMANDS", small.commands <= CERTIFICATE_PASS_RUN_COMMANDS, true);

  part("ALTO 2: the sweep's turns, one MGET for the batch, one SET NX EX a pass");
  const dueOf = (pass as unknown as { certificatePassesDue: (stores: Store[]) => Promise<Set<string>> }).certificatePassesDue;
  const take = (pass as unknown as { takeCertificatePass: (store: Store) => Promise<boolean> }).takeCertificatePass;
  let before = commands;
  const due = await dueOf([two.store, many.store]);
  is("both stores' turns are read with one command", commands - before, 1);
  is("a turn never taken is due", [due.has(two.store.statsId!), due.has(many.store.statsId!)], [true, true]);
  is("a store's turn is taken once", [await take(many.store), await take(many.store)], [true, false]);
  is("and held as not due", [await turnOf(many.store), (await dueOf([two.store, many.store])).has(many.store.statsId!)], ["1", false]);
  const ttl = Number((await healthy([["TTL", `nl:certrefunds:next:${many.store.statsId}`]]))[0]);
  is("for CERTIFICATE_PASS_EVERY_SECONDS", ttl > 0 && ttl <= (exported.CERTIFICATE_PASS_EVERY_SECONDS as number), true);
  replaced.set("MGET", [null, 7]);
  is("a turn read in another shape runs no pass of that store this run", [...(await dueOf([two.store, many.store]))], [two.store.statsId]);
  replaced.set("MGET", "OK");
  is("a reply that is not a list runs none this run", (await dueOf([two.store, many.store])).size, 0);
  replaced.clear();
  before = commands;
  is("a batch with no store paid through Stripe with a course reads nothing", [(await dueOf([])).size, commands - before], [0, 0]);
  await healthy([["DEL", `nl:certrefunds:next:${many.store.statsId}`]]);

  part("A full refund withdraws the certificate, at a priced cost");
  const ana = buy("twocourses", "ana@example.com", two.products[0]);
  const anaId = await issue(two.store, two.products[0], two.courseIds[0], "ana@example.com", "Ana Example");
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

  part("A certificate issued with no store id on its room (before the store had one) is met by its refund all the same");
  const ben = buy("manycourses", "ben@example.com", many.products[117]);
  const benId = await issue(many.store, many.products[117], many.courseIds[117], "ben@example.com", "Ben Example", { ...ROOM, statsId: null });
  refundInFull(ben);
  await run(many.store);
  is("its full refund withdraws it", ((await record(benId))?.withdrawnAt ?? 0) > 0, true);

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
  const ceilings = exported.CERTIFICATE_REFUND_CHECKS_PER_MONTH as Record<string, number>;
  const ceiling = ceilings[two.store.tier];
  is("the month's checks are a named, exported ceiling for each plan", ["creator", "pro", "scale"].every((tier) => Number.isSafeInteger(ceilings[tier]) && ceilings[tier] > 0), true);
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
  is("the line has a figure above zero for every paid plan", (["creator", "pro", "scale"] as const).every((tier) => (line?.monthlyUsd(tier) ?? 0) > 0), true);
  is("a plan with more checks costs more", (line?.monthlyUsd("creator") ?? 0) < (line?.monthlyUsd("pro") ?? 0) && (line?.monthlyUsd("pro") ?? 0) < (line?.monthlyUsd("scale") ?? 0), true);
  console.log(`  (the line: $${(line?.monthlyUsd("creator") ?? 0).toFixed(4)} a Store store a month)`);
  const registry = NOT_A_COST as Record<string, string | undefined>;
  is("the pages and lookups are no longer a company fixed cost", ["CERTIFICATE_REFUND_PAGES_PER_STORE", "CERTIFICATE_REFUND_LOOKUPS_PER_STORE"].some((name) => name in registry), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
