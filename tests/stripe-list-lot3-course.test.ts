/**
 * Kept as a permanent test from Codex G's proof on #2781 (codex/g-review-2781-course-cleanup 70ece45b,
 * tests/g2781-course-cleanup.proof.ts; C4-20261106-0740-TODOS-34): a refunded place loses its course access even
 * when the removal fails between taking the access away and deleting the place's record. Every course, grant, pass
 * and revocation function is the real one; only the transport is a stand-in.
 */
/**
 * CX-123 rules 24 and 30, lists from Stripe, lot 3 (a) (money and access; C4-20261106-0450-C5-16): the refunds
 * that take a purchase for several back (lib/group-buy.ts, revokeRefundedGroups) are read in Stripe's exact list
 * shape (lib/stripe-list.ts, refundRowKnown in lib/refunds.ts) and to their end. Against a stand-in for Stripe:
 *
 *   - a page in another shape, or a row not readable, never moves the anchor, so those refunds are read again;
 *   - a refund on a later page is read and takes the purchase back, and the anchor moves only after the last page;
 *   - a refund on a readable row takes its purchase back even beside a row not readable (a "yes" stands), and the
 *     anchor stays;
 *   - more pages than one run reads leave the anchor where it was, and the next run goes on from where the last
 *     stopped, so a refund past them is reached (Codex G on #2781, M1);
 *   - a refund is marked handled only once its work was written: the group's close failing, or the reply that names
 *     its purchase lost, marks nothing, and a later run takes the purchase back (Codex G on #2781, M2);
 *   - a purchase already closed whose places were not all taken back (a run that stopped halfway) has them taken back
 *     now (Claude 4 on #2781, M3);
 *   - a refund whose purchase record does not read never holds back the refunds after it: it is kept on a short
 *     list tried first on every run, and let go only once handled (it never expires); with that list full, the pass
 *     stays on its page;
 *     an anchor in another shape starts no pass (Claude 4 on #2781, C4-20261106-0645-C5-25);
 *   - the places a purchase handed out are read exactly: a list of them in another shape (null, an odd length, a
 *     value not text) or one place that does not read is unknown, never "nobody": the refund is not marked, waits to
 *     be tried again, and a healthy run takes the place back (Codex G on #2781, proof 1e7a4920; C4-20261106-0710-C5-29);
 *   - every read is pinned to the lot's version.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { askPlace, revokeRefundedGroups, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
import { createCheckout } from "@/lib/store-checkout";
import { emptyCourse, editCourse, saveCourse } from "@/lib/course";
import { courseAccess, dropEnrollment, recordEnrollment, mintPass, passCookieName, forgetPaid } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let pages: unknown[] = [];
const mails: { to: string[]; text: string }[] = [];
const reads: { after: string | null; version: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)) as { to: string[]; text: string });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") return new Response(JSON.stringify({ id: `cs_test_${"t".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  if (path === "/refunds" && method === "GET") {
    const after = url.searchParams.get("starting_after");
    reads.push({ after, version: new Headers(init?.headers).get("stripe-version") });
    const index = after ? pages.findIndex((p) => ((p as { data?: { id?: string }[] }).data ?? []).some((row) => row?.id === after)) + 1 : 0;
    return new Response(JSON.stringify(pages[Math.min(index, pages.length - 1)]));
  }
  if (path === "/checkout/sessions" && method === "GET") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const list = (data: unknown[], hasMore = false) => ({ object: "list", data, has_more: hasMore });
const GARBLED: [string, unknown][] = [
  ["no data", { object: "list", has_more: false }],
  ["data not a list", { object: "list", data: {}, has_more: false }],
  ["has_more missing", { object: "list", data: [] }],
  ["has_more as text", { object: "list", data: [], has_more: "false" }],
  ["not an object", []],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_lot_three_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  await claimHandle("lotthree@example.com", "lotthree", "Lot Three", "");
  await ensureStatsId("lotthree@example.com");
  await setStripeAccount("lotthree@example.com", "acct_1LotThreeGroup1", true);
  await setSubscription("lotthree@example.com", { customerId: "cus_LotThree001", subscriptionId: "sub_LotThree001", active: true, period: paidPeriod() });
  const made = await addProduct("lotthree@example.com", "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  let course = emptyCourse();
  const lesson = editCourse(course, { op: "lesson-add", moduleId: course.modules[0].id, title: "A real lesson" });
  if (!lesson.ok) throw Error("no lesson"); course = lesson.course;
  await saveCourse(course, (await storeForEmail("lotthree@example.com"))!);
  if (!(await setProductCourse("lotthree@example.com", made.product.id, { id: course.id, lessons: 1 })).ok) throw Error("no course product");
  const store = (await storeForEmail("lotthree@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const full = (await readProduct(store, product.id))!;
  /** A purchase for two, paid with this payment. */
  const paidGroup = async (pi: string, n: number): Promise<string> => {
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no purchase for several");
    await createCheckout(store, full, "https://marktmorgen.com", "", { group: { id: started.group.id, people: 2 }, digitalConsent: TEST_CONSENT });
    const meta = { store: "lotthree", product: product.id, group: started.group.id, people: "2" };
    const session = { id: "cs_test_" + String(n).repeat(24), created: 1_900_000_000, amount_total: 9800, currency: "usd", payment_intent: pi, metadata: meta, customer_details: { email: `buyer${n}@example.com` } };
    if ((await settleGroup({ store, session, product, base: "https://marktmorgen.com/@lotthree", from: '"Lot Three" <hello@marktmorgen.com>' })) !== "settled") throw new Error("not settled");
    return started.group.id;
  };
  const anchorKey = `nl:grp:${store.statsId}:refunds`;
  const anchor = async () => (await redis.pipeline([["GET", anchorKey]]))[0];
  const run = () => revokeRefundedGroups(store, Date.now() + 30_000, async () => {});
  const now = Math.floor(Date.now() / 1000);
  // Rule 23: the refund and its charge now carry their amounts, as Stripe lists them: since the owner's decision 18 (9 November
  // 2026) a succeeded refund takes the places back only when its amount covers the charge, or the charge's refunds add up.
  const refund = (id: string, pi: string, created = now) => ({ id, object: "refund", created, status: "succeeded", amount: 4900, payment_intent: pi, charge: { refunded: true, amount: 4900 } });
  const other = (n: number) => refund(`re_LotThreeOther${String(n).padStart(3, "0")}`, `pi_LotThreeElse${String(n).padStart(3, "0")}`, now - n);


  part("G: removal must include the independent course-access ledger");
  for (const [n, mode] of ["control", "imported HDEL response lost", "course ledger removal fails"].entries()) {
    await redis.pipeline([["DEL", anchorKey], ["DEL", `${anchorKey}:pass`], ["DEL", `${anchorKey}:retry`]]);
    const pi = `pi_GCourseCleanup${n}`;
    const refundId = `re_GCourseCleanup${n}`;
    const group = await paidGroup(pi, 30 + n);
    const email = `student${n}@example.com`;
    const holder = (await storeForEmail("lotthree@example.com"))!;
    const asked = await askPlace({ store: holder, id: group, email, product, base: "https://marktmorgen.com/@lotthree", from: '"Lot Three" <hello@marktmorgen.com>', ordersLink: async () => null });
    const token = mails.filter((m) => m.to[0] === email).at(-1)?.text.match(/\?take=([0-9a-f]{64})/)?.[1] ?? "";
    const took = await takePlace({ store: holder, token, recordStart: (who, id, at) => recordEnrollment(holder, who, id, at) });
    const pass = await mintPass(holder, email, [course.id]);
    const cookies = { get: (name: string) => name === passCookieName(holder) ? { value: pass } : undefined };
    is(`${mode}: real grant and course access before refund`, [asked, took.outcome, (await courseAccess(holder, product, cookies)).state], ["sent", "taken", "open"]);
    pages = [list([refund(refundId, pi)])];
    const real = redis.pipeline.bind(redis);
    let hit = 0, drops = 0;
    const drop = async (who: string, id: string) => { drops += 1; await dropEnrollment(holder, who, id); };
    redis.pipeline = async (commands: (string | number)[][]) => {
      if (mode === "course ledger removal fails" && commands[0]?.[0] === "HDEL" && String(commands[0]?.[1]).startsWith("nl:learn:enr:")) { hit += 1; throw Error("G provider failure before ledger HDEL applied"); }
      const reply = await real(commands);
      if (mode === "imported HDEL response lost" && commands[0]?.[0] === "HDEL" && String(commands[0]?.[1]).startsWith("nl:imp:buy:")) { hit += 1; return ["QUEUED"]; }
      return reply;
    };
    try { await revokeRefundedGroups(holder, Date.now() + 30_000, drop).catch(() => 0); }
    finally { redis.pipeline = real; }
    is(`${mode}: intended transport boundary reached`, hit, mode === "control" ? 0 : 1);
    await revokeRefundedGroups(holder, Date.now() + 30_000, drop);
    await forgetPaid(holder, email); // A real cache invalidation, so this is not a stale ten-minute answer.
    const access = await courseAccess(holder, product, cookies);
    const seen = (await redis.pipeline([["SISMEMBER", `nl:grp:${holder.statsId}:seen`, refundId]]))[0];
    const remains = await importedFor(holder, email);
    console.log("G_COURSE_AFTER", JSON.stringify({ mode, hit, drops, seen, imported: remains.length, course: access.state }));
    is(`${mode}: healthy retry removes refunded course authority`, [seen, remains.length, access.state], [1, 0, "closed"]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
