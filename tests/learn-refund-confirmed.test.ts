/**
 * A paid course is taken away only once its money is back (owner decision 18, C1-20261109-1029-C5-52: "retirar o
 * acesso somente quando o reembolso for confirmado (succeeded) ou a disputa for perdida; em failed/canceled o acesso
 * continua; o comprador não pode perder o acesso sem ter o dinheiro de volta; pendente por muitos dias gera alerta,
 * não revogação"). Claude 6, second money review of #3376 (HIGH 1).
 *
 * #3376 made every one-off course written down from a Stripe checkout, and every entry written before origins were
 * kept (no letter: every entry on the ledger today, PayPal, gift, pre-order and group places included), "unknown"
 * while Stripe could not be read whole: a buyer who paid and was never refunded lost the course whenever Stripe
 * failed. It did so to keep a course refunded in full from opening again on an answer that could not be read.
 *
 * Now both sides hold:
 *   - while Stripe cannot be read whole, a one-off course written down stays open, whatever its origin: the state
 *     that cannot be read keeps what there was and asks again next time;
 *   - a refund Stripe confirms (its refunds succeeded for the whole charge) or a dispute lost takes the course off
 *     the ledger for good, read on a whole answer and matched to the very checkout the entry was written for (its
 *     start is that checkout's time), so it never opens again, Stripe readable or not;
 *   - a refund still pending, failed or canceled takes nothing off the ledger; one pending past seven days is logged;
 *   - what Stripe alone decides (a membership, a course never written down) stays unknown, as before, and a student
 *     the creator took off a course is shut, not "unknown" (first review's LOW 1, second review's LOW 3).
 *
 * Synthetic only: an in-memory Redis and a stand-in for the creator's Stripe account.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { courseAccess, emailKey, forgetPaid, mintPass, paidCourses, passCookieName, recordEnrollment, storeKey } from "@/lib/learn";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_learn_refund_confirmed";

const OWNER = "teacher@example.com";
const HANDLE = "glazeworks";
const ACCOUNT = "acct_1TestRefundOk";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ONE_OFF_COURSE = "e".repeat(32);
const MEMBER_COURSE = "f".repeat(32);

/** Checkouts by the address they were paid from. */
const sessions: Record<string, Record<string, unknown>[]> = {};
/** A payment's refunds, by its PaymentIntent id. */
const refunds: Record<string, Record<string, unknown>[]> = {};
/** A charge's disputes, by its id. */
const disputes: Record<string, Record<string, unknown>[]> = {};
/** A payment plan's first invoice's PaymentIntent, by the invoice id. */
const planIntents: Record<string, string> = {};
/** A PaymentIntent read on its own, with its latest charge expanded. */
const intents: Record<string, Record<string, unknown>> = {};
/** When true, the list of checkouts cannot be read. */
let down = false;
/** When true, the list of a payment's refunds cannot be read. */
let refundsDown = false;
let refundReads = 0;

const STRIPE_HOSTS = new Set(["api.stripe.com"]);

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (!STRIPE_HOSTS.has(url.hostname)) return answer({ error: "no sending in this test" }, 500);
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    if (down) return answer({ error: { message: "down" } }, 500);
    const data = sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [];
    return answer({ object: "list", data, has_more: false, url: "/v1/checkout/sessions" });
  }
  if (path === "/refunds") {
    refundReads += 1;
    if (refundsDown) return answer({ error: { message: "down" } }, 500);
    const data = refunds[url.searchParams.get("payment_intent") ?? ""] ?? [];
    return answer({ object: "list", data, has_more: false, url: "/v1/refunds" });
  }
  if (path === "/disputes") {
    const data = disputes[url.searchParams.get("charge") ?? ""] ?? [];
    return answer({ object: "list", data, has_more: false, url: "/v1/disputes" });
  }
  // A payment plan's first invoice, its payments, and each payment with its charge (lib/refunds.ts planRefundedInFull).
  const invoice = /^\/invoices\/(in_\w+)$/.exec(path)?.[1];
  if (invoice) return answer({ id: invoice, object: "invoice", payment_intent: null });
  if (path === "/invoice_payments") {
    const intent = planIntents[url.searchParams.get("invoice") ?? ""];
    const data = intent ? [{ id: `inpay_${intent.slice(3)}`, object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: intent } }] : [];
    return answer({ object: "list", data, has_more: false, url: "/v1/invoice_payments" });
  }
  const intent = /^\/payment_intents\/(pi_\w+)$/.exec(path)?.[1];
  if (intent && intents[intent]) return answer(intents[intent]);
  return answer({ object: "list", data: [], has_more: false, url: path });
}) as typeof fetch;

type Paid = { refunded?: boolean; disputed?: boolean };

/** A one-off checkout for a course, created at `created`, its charge refunded in full or disputed as told. */
const oneOff = (id: string, product: string, created: number, { refunded = false, disputed = false }: Paid = {}) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created,
  customer: "cus_TestRefundConfirmed1",
  metadata: { store: HANDLE, product },
  payment_intent: {
    id: `pi_${id.slice(8)}`,
    object: "payment_intent",
    latest_charge: { object: "charge", id: `ch_${id.slice(8)}`, amount: 4900, amount_refunded: refunded ? 4900 : 0, refunded, disputed },
  },
});
const membership = (id: string, product: string, created: number) => ({
  id,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  created,
  customer: "cus_TestRefundConfirmed2",
  metadata: { store: HANDLE, product },
  payment_intent: null,
  subscription: { id: `sub_${id.slice(8)}`, object: "subscription", status: "active" },
});
/**
 * One refund row as GET /refunds lists it, in Stripe's real shape: its charge an id, since nothing expands it
 * (Claude 6's focal review of #3376, MEDIUM A: a fixture with `charge: null` hid that every real row read as
 * unreadable). `expanded` gives the charge as an object instead, as with `expand[]=data.charge`.
 */
const refund = (id: string, intent: string, status: string, amount: number, created = NOW - DAY, expanded = false) => ({
  id,
  object: "refund",
  status,
  amount,
  created,
  payment_intent: intent,
  charge: expanded ? { object: "charge", id: `ch_${intent.slice(3)}`, refunded: true } : `ch_${intent.slice(3)}`,
});
/** A one-off course bought on a payment plan: a subscription checkout with kind=plan, its first invoice paid. */
const onPlan = (id: string, product: string, created: number) => ({
  id,
  object: "checkout.session",
  mode: "subscription",
  status: "complete",
  payment_status: "paid",
  created,
  customer: "cus_TestRefundConfirmed3",
  metadata: { store: HANDLE, product, kind: "plan" },
  payment_intent: null,
  invoice: `in_${id.slice(8)}`,
  subscription: { id: `sub_${id.slice(8)}`, object: "subscription", status: "active" },
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Glazeworks", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const single = await addProduct(OWNER, "Glaze Basics", "", "49", null);
  const club = await addProduct(OWNER, "Glaze Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!single.ok || !club.ok) throw new Error("no product");
  await setProductCourse(OWNER, single.product.id, { id: ONE_OFF_COURSE, lessons: 3 });
  await setProductCourse(OWNER, club.product.id, { id: MEMBER_COURSE, lessons: 3 });
  const store = (await storeForEmail(OWNER))!;
  const one = (await readListing(store, single.product.id))!;
  const member = (await readListing(store, club.product.id))!;

  const pass = async (email: string) => {
    const token = await mintPass(store, email, "all");
    return { get: (name: string) => (name === passCookieName(store) ? { value: token } : undefined) };
  };
  const stateOf = async (email: string, product: typeof one) => {
    await forgetPaid(store, email);
    return (await courseAccess(store, product, await pass(email))).state;
  };
  const ledgerKey = (email: string) => `nl:learn:enr:${storeKey(store)}:${emailKey(email)}`;
  const written = async (email: string, product: string) => (await redis.pipeline([["HGET", ledgerKey(email), product]]))[0];
  const T1 = NOW - 20 * DAY;
  const T2 = NOW - 5 * DAY;

  part("A buyer who paid and was never refunded keeps the course while Stripe cannot be read");
  sessions["paid@example.com"] = [oneOff("cs_test_paid00000001", one.id, T1)];
  await recordEnrollment(store, "paid@example.com", one.id, T1, "stripe");
  down = false;
  is("a Stripe checkout written down: open while Stripe reads (control)", await stateOf("paid@example.com", one), "open");
  down = true;
  is("a Stripe checkout written down, never refunded: still open while Stripe cannot be read", await stateOf("paid@example.com", one), "open");
  is("paidCourses opens it with the start written down", (await paidCourses(store, "paid@example.com")).get(one.id), T1);
  await redis.pipeline([["HSET", ledgerKey("old@example.com"), one.id, String(T1)]]);
  is("an entry written before origins were kept (no letter): still open while Stripe cannot be read", await stateOf("old@example.com", one), "open");
  down = false;

  part("A partial reading keeps what was written down");
  // Its own checkout is the row that does not read: the reading is not whole, and nothing in it shows the purchase.
  sessions["half@example.com"] = [{ id: "cs_test_half00000001", metadata: "garbled" }];
  await recordEnrollment(store, "half@example.com", one.id, T1, "stripe");
  is("a course written down, its checkout on a row that does not read: open", await stateOf("half@example.com", one), "open");

  part("A refund Stripe confirms takes the course off the ledger, for good");
  sessions["back@example.com"] = [oneOff("cs_test_back00000001", one.id, T1, { refunded: true })];
  refunds["pi_back00000001"] = [refund("re_back00000001", "pi_back00000001", "succeeded", 4900)];
  await recordEnrollment(store, "back@example.com", one.id, T1, "stripe");
  is("refunded in full and succeeded: shut", await stateOf("back@example.com", one), "closed");
  is("and taken off the ledger", await written("back@example.com", one.id), null);
  down = true;
  is("so it never opens again while Stripe cannot be read", await stateOf("back@example.com", one), "unknown");
  down = false;
  // A new purchase after the refund (C1-20261109-1054-C5-54, point 2): written down again on its thanks page, it opens.
  sessions["back@example.com"] = [oneOff("cs_test_back00000002", one.id, T2), ...sessions["back@example.com"]];
  await recordEnrollment(store, "back@example.com", one.id, T2, "stripe");
  is("bought again after the refund: written down again with the new start", await written("back@example.com", one.id), `${T2}:s`);
  is("bought again after the refund: open", await stateOf("back@example.com", one), "open");
  down = true;
  is("bought again after the refund: open while Stripe cannot be read", await stateOf("back@example.com", one), "open");
  down = false;
  sessions["parts@example.com"] = [oneOff("cs_test_part00000001", one.id, T1, { refunded: true })];
  refunds["pi_part00000001"] = [refund("re_part00000002", "pi_part00000001", "succeeded", 2900), refund("re_part00000001", "pi_part00000001", "succeeded", 2000)];
  await recordEnrollment(store, "parts@example.com", one.id, T1, "stripe");
  is("refunded in two parts, both succeeded: shut", await stateOf("parts@example.com", one), "closed");
  is("and taken off the ledger", await written("parts@example.com", one.id), null);
  sessions["wide@example.com"] = [oneOff("cs_test_wide00000001", one.id, T1, { refunded: true })];
  refunds["pi_wide00000001"] = [refund("re_wide00000001", "pi_wide00000001", "succeeded", 4900, NOW - DAY, true)];
  await recordEnrollment(store, "wide@example.com", one.id, T1, "stripe");
  is("a refund row with its charge expanded reads too: shut", await stateOf("wide@example.com", one), "closed");
  is("and taken off the ledger", await written("wide@example.com", one.id), null);
  await redis.pipeline([["HSET", ledgerKey("oldback@example.com"), one.id, String(T1)]]);
  sessions["oldback@example.com"] = [oneOff("cs_test_oldb00000001", one.id, T1, { refunded: true })];
  refunds["pi_oldb00000001"] = [refund("re_oldb00000001", "pi_oldb00000001", "succeeded", 4900)];
  is("an old entry (no letter) refunded and succeeded: shut", await stateOf("oldback@example.com", one), "closed");
  is("and taken off the ledger", await written("oldback@example.com", one.id), null);

  part("A dispute lost takes the course off the ledger");
  sessions["lost@example.com"] = [oneOff("cs_test_lost00000001", one.id, T1, { disputed: true })];
  disputes["ch_lost00000001"] = [{ id: "dp_lost00000001", object: "dispute", status: "lost" }];
  await recordEnrollment(store, "lost@example.com", one.id, T1, "stripe");
  is("a dispute lost: shut", await stateOf("lost@example.com", one), "closed");
  is("and taken off the ledger", await written("lost@example.com", one.id), null);

  part("A refund not confirmed takes nothing away, Stripe readable or not");
  for (const status of ["pending", "requires_action", "failed", "canceled"]) {
    const email = `refund-${status.replace(/_/g, "-")}@example.com`;
    const tag = status.slice(0, 4).padEnd(4, "x");
    sessions[email] = [oneOff(`cs_test_${tag}00000009`, one.id, T1, { refunded: true })];
    refunds[`pi_${tag}00000009`] = [refund(`re_${tag}00000009`, `pi_${tag}00000009`, status, 4900)];
    await recordEnrollment(store, email, one.id, T1, "stripe");
    // Stripe marks the charge refunded while its refund is still pending (Claude 6's focal review, MEDIUM B).
    is(`a refund ${status}: open while Stripe reads whole`, await stateOf(email, one), "open");
    is(`a refund ${status}: the entry stays on the ledger`, await written(email, one.id), `${T1}:s`);
    down = true;
    is(`a refund ${status}: open while Stripe cannot be read`, await stateOf(email, one), "open");
    down = false;
  }
  sessions["short@example.com"] = [oneOff("cs_test_shrt00000001", one.id, T1, { refunded: true })];
  refunds["pi_shrt00000001"] = [refund("re_shrt00000001", "pi_shrt00000001", "succeeded", 2000), refund("re_shrt00000002", "pi_shrt00000001", "pending", 2900)];
  await recordEnrollment(store, "short@example.com", one.id, T1, "stripe");
  await stateOf("short@example.com", one);
  is("only part of the money succeeded: the entry stays", await written("short@example.com", one.id), `${T1}:s`);
  is("only part of the money succeeded: open while Stripe reads whole", await stateOf("short@example.com", one), "open");
  sessions["noread@example.com"] = [oneOff("cs_test_nord00000001", one.id, T1, { refunded: true })];
  refunds["pi_nord00000001"] = [refund("re_nord00000001", "pi_nord00000001", "succeeded", 4900)];
  await recordEnrollment(store, "noread@example.com", one.id, T1, "stripe");
  refundsDown = true;
  await stateOf("noread@example.com", one);
  is("the refunds could not be read: the entry stays (unknown is not 'succeeded')", await written("noread@example.com", one.id), `${T1}:s`);
  refundsDown = false;
  await stateOf("noread@example.com", one);
  is("read again: now taken off", await written("noread@example.com", one.id), null);

  part("A course bought on a payment plan is taken off only once its first payment's refund succeeded");
  sessions["plan@example.com"] = [onPlan("cs_test_plan00000001", one.id, T1)];
  planIntents["in_plan00000001"] = "pi_plan00000001";
  intents["pi_plan00000001"] = {
    id: "pi_plan00000001",
    object: "payment_intent",
    latest_charge: { object: "charge", id: "ch_plan00000001", amount: 4900, amount_refunded: 4900, refunded: true, disputed: false },
  };
  refunds["pi_plan00000001"] = [refund("re_plan00000001", "pi_plan00000001", "pending", 4900)];
  await recordEnrollment(store, "plan@example.com", one.id, T1, "stripe");
  is("a plan's refund pending: open while Stripe reads whole", await stateOf("plan@example.com", one), "open");
  is("a plan's refund pending: the entry stays", await written("plan@example.com", one.id), `${T1}:s`);
  refunds["pi_plan00000001"] = [refund("re_plan00000001", "pi_plan00000001", "succeeded", 4900)];
  is("a plan's refund succeeded: shut", await stateOf("plan@example.com", one), "closed");
  is("and taken off the ledger", await written("plan@example.com", one.id), null);
  down = true;
  is("so it stays shut while Stripe cannot be read", await stateOf("plan@example.com", one), "unknown");
  down = false;

  part("A Stripe refund never takes off an entry that also stands for a sale from another source (P7)");
  sessions["mixed@example.com"] = [oneOff("cs_test_mixd00000001", one.id, T1, { refunded: true })];
  refunds["pi_mixd00000001"] = [refund("re_mixd00000001", "pi_mixd00000001", "succeeded", 4900)];
  await recordEnrollment(store, "mixed@example.com", one.id, T1, "stripe");
  // Paid again through PayPal before any reading saw the Stripe refund: its own write stood for nothing (HSETNX).
  await recordEnrollment(store, "mixed@example.com", one.id, T2, "paypal");
  is("the entry now says PayPal, with the first start kept", await written("mixed@example.com", one.id), `${T1}:p`);
  is("Stripe refunded, PayPal paid: open while Stripe reads whole", await stateOf("mixed@example.com", one), "open");
  is("and the entry stays", await written("mixed@example.com", one.id), `${T1}:p`);
  down = true;
  is("and stays open while Stripe cannot be read", await stateOf("mixed@example.com", one), "open");
  down = false;
  await redis.pipeline([["HSET", ledgerKey("mixold@example.com"), one.id, String(T1)]]);
  await recordEnrollment(store, "mixold@example.com", one.id, T2, "gift");
  is("an old entry (no letter) a gift wrote over: says gift, first start kept", await written("mixold@example.com", one.id), `${T1}:g`);
  await recordEnrollment(store, "mixold@example.com", one.id, T2, "stripe");
  is("a Stripe write never takes another origin's place", await written("mixold@example.com", one.id), `${T1}:g`);

  part("The entry is taken off only while it is still the one read (compare and delete)");
  sessions["race@example.com"] = [oneOff("cs_test_race00000001", one.id, T1, { refunded: true })];
  refunds["pi_race00000001"] = [refund("re_race00000001", "pi_race00000001", "succeeded", 4900)];
  await recordEnrollment(store, "race@example.com", one.id, T1, "stripe");
  const pipeline = redis.pipeline.bind(redis);
  let raced = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // A sale of another source written between this request's read of the ledger and its delete.
    if (!raced && commands.some((command) => command[0] === "HDEL" || String(command[1]).includes("learn-take-off-if"))) {
      raced = true;
      await pipeline([["HSET", ledgerKey("race@example.com"), one.id, `${T2}:p`]]);
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  await stateOf("race@example.com", one);
  redis.pipeline = pipeline;
  is("the race was run", raced, true);
  is("what was written in between is not deleted", await written("race@example.com", one.id), `${T2}:p`);

  part("A long pending refund is logged, not acted on");
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  };
  sessions["slow@example.com"] = [oneOff("cs_test_slow00000001", one.id, T1, { refunded: true })];
  refunds["pi_slow00000001"] = [refund("re_slow00000001", "pi_slow00000001", "pending", 4900, NOW - 9 * DAY)];
  await recordEnrollment(store, "slow@example.com", one.id, T1, "stripe");
  await stateOf("slow@example.com", one);
  console.warn = warn;
  is("pending nine days: logged", warned.some((line) => line.includes("pending")), true);
  is("and the entry stays", await written("slow@example.com", one.id), `${T1}:s`);

  part("Only the checkout the entry was written for is taken off");
  sessions["again@example.com"] = [oneOff("cs_test_agan00000002", one.id, T2), oneOff("cs_test_agan00000001", one.id, T1, { refunded: true })];
  refunds["pi_agan00000001"] = [refund("re_agan00000001", "pi_agan00000001", "succeeded", 4900)];
  await recordEnrollment(store, "again@example.com", one.id, T1, "stripe");
  is("bought again after a refund: open", await stateOf("again@example.com", one), "open");
  is("the entry stays, since a purchase stands", await written("again@example.com", one.id), `${T1}:s`);
  down = true;
  is("and stays open while Stripe cannot be read", await stateOf("again@example.com", one), "open");
  down = false;
  await recordEnrollment(store, "paypal@example.com", one.id, T2, "paypal");
  sessions["paypal@example.com"] = [oneOff("cs_test_ppal00000001", one.id, T1, { refunded: true })];
  refunds["pi_ppal00000001"] = [refund("re_ppal00000001", "pi_ppal00000001", "succeeded", 4900)];
  await stateOf("paypal@example.com", one);
  is("a PayPal entry is never taken off by a Stripe refund", await written("paypal@example.com", one.id), `${T2}:p`);
  await redis.pipeline([["HSET", ledgerKey("elsewhen@example.com"), one.id, String(T2)]]);
  sessions["elsewhen@example.com"] = [oneOff("cs_test_elsw00000001", one.id, T1, { refunded: true })];
  refunds["pi_elsw00000001"] = [refund("re_elsw00000001", "pi_elsw00000001", "succeeded", 4900)];
  await stateOf("elsewhen@example.com", one);
  is("an old entry written at another time than the refunded checkout stays", await written("elsewhen@example.com", one.id), String(T2));

  part("What Stripe alone decides is still unknown, and nothing unpaid opens");
  down = true;
  is("a course never written down: unknown, not open", await stateOf("stranger@example.com", one), "unknown");
  await recordEnrollment(store, "club@example.com", member.id, T1, "stripe");
  is("a membership course written down: unknown (only Stripe says it is live)", await stateOf("club@example.com", member), "unknown");
  down = false;
  sessions["club@example.com"] = [membership("cs_test_club00000001", member.id, T1)];
  is("Stripe read again: the member opens", await stateOf("club@example.com", member), "open");

  part("A student the creator took off a course is shut, not unknown");
  await redis.pipeline([["SADD", `nl:course:${ONE_OFF_COURSE}:blocked`, emailKey("taken@example.com")]]);
  await redis.pipeline([["SADD", `nl:course:${MEMBER_COURSE}:blocked`, emailKey("taken@example.com")]]);
  await recordEnrollment(store, "taken@example.com", one.id, T1, "stripe");
  down = true;
  is("a one-off written down, taken off by the creator: shut while Stripe cannot be read", await stateOf("taken@example.com", one), "closed");
  is("a membership, taken off by the creator: shut, not unknown", await stateOf("taken@example.com", member), "closed");
  down = false;

  part("Asking for confirmation is bounded");
  refundReads = 0;
  await stateOf("paid@example.com", one);
  is("a purchase not refunded asks nothing more", refundReads, 0);
  await stateOf("oldback@example.com", one);
  is("a refund already taken off asks nothing more", refundReads, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
