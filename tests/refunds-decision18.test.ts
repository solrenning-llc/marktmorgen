/**
 * The owner's decision 18 (9 November 2026, C1-20261109-1029-C5-52), in the one place every door and job reads a
 * refund (lib/refunds.ts): "a full refund still pending takes access away only once the refund is confirmed
 * (succeeded) or the dispute is lost. It applies to everyone: group, gift, pre-order and license key. On failed or
 * canceled, access stays. The buyer may never lose access without having the money back. Handle a refund made in
 * parts. Pending for many days raises an alert, not a revocation."
 *
 * Stripe already counts a refund still on its way in the charge's `amount_refunded` (and marks the charge
 * `refunded`), so neither field alone says the money went back. Checked here:
 *
 *   - a row of a job's reading: only a succeeded refund that gives the whole charge back by itself, or a lost
 *     dispute, gives back (rowGivesBack); pending and requires_action are held, never given back;
 *   - a payment read at a door (givenBack, purchaseRefunded): "refunded in full" only when the charge's own refunds,
 *     read whole from GET /refunds?charge=, add up to the charge in succeeded ones; one still on its way keeps
 *     access; a list that does not read is unknown, which never takes access away (purchaseRefunded) and is never
 *     a "no" (givenBack throws, as when Stripe cannot be asked);
 *   - a refund in parts: the succeeded parts adding up to the charge give back; a part still pending does not;
 *   - a full refund pending for more than seven days is said in the log, at most once a charge a day (one
 *     SET NX EX 86400), and still takes nothing away;
 *   - controls: a refund failed or canceled (the charge no longer reads refunded) keeps access, with no extra read.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts. Nothing real is reached.
 */
import { givenBack, purchaseRefunded, rowGivesBack } from "@/lib/refunds";
import { paidCall } from "@/lib/calls";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_refunds_decision18_synthetic";

const ACCOUNT = "acct_refundd18001";
const CHARGE = "ch_refundd18charge1";
const INTENT = "pi_refundd18intent1";
const NOW = Math.floor(Date.now() / 1000);
const BOOKING = "cs_test_refundd18booking1";
const callStore = { handle: "d18calls", previousHandles: [], releasedHandles: [], stripeAccountId: ACCOUNT } as unknown as Store;
/** A booked call paid by the payment below, as Stripe sends its checkout. */
let booking: Record<string, unknown> = {};

/** What GET /refunds?charge= answers: the charge's refunds, or anything else for an answer in another shape. */
let chargeRefunds: unknown = { object: "list", data: [], has_more: false };
let calls: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  calls.push(`${path}${url.search}`);
  if (path === "/refunds" && url.searchParams.get("charge") === CHARGE) return Response.json(chargeRefunds);
  if (path === "/disputes") return Response.json({ object: "list", data: [], has_more: false });
  if (path === `/checkout/sessions/${BOOKING}`) return Response.json(booking);
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

/** A refund of the charge as Stripe lists it. */
function refund(id: string, status: string, amount: number, created = NOW - 60): Record<string, unknown> {
  return { id, object: "refund", status, amount, created, charge: CHARGE, payment_intent: INTENT };
}

/** The payment as a door reads it: the intent with its latest charge expanded, Stripe's fields as they are. */
function payment(back: number, amount = 2500): Record<string, unknown> {
  return {
    id: INTENT,
    object: "payment_intent",
    latest_charge: { object: "charge", id: CHARGE, amount, amount_refunded: back, refunded: back >= amount, disputed: false, payment_intent: INTENT },
  };
}

/** A row of a job's reading of GET /refunds with its charge expanded. */
function row(status: string, amount: number, back: number): Record<string, unknown> {
  return { ...refund("re_refundd18row0001", status, amount), charge: { object: "charge", id: CHARGE, amount: 2500, amount_refunded: back, refunded: back >= 2500 } };
}

const session = (back: number) => ({ mode: "payment", payment_intent: payment(back), metadata: { store: "shop" } });

async function main(): Promise<void> {
  redis.clear();

  part("A row of a job's reading: only money gone back for good gives back");
  is("a full refund still pending does not give back", rowGivesBack(row("pending", 2500, 2500)), false);
  is("a full refund requiring action does not give back", rowGivesBack(row("requires_action", 2500, 2500)), false);
  is("a full refund that succeeded gives back", rowGivesBack(row("succeeded", 2500, 2500)), true);
  is("control: a refund that failed does not give back", rowGivesBack(row("failed", 2500, 0)), false);
  is("control: a refund that was canceled does not give back", rowGivesBack(row("canceled", 2500, 0)), false);

  part("A door: a full refund still pending keeps access");
  chargeRefunds = { object: "list", data: [refund("re_refundd18pend01", "pending", 2500)], has_more: false };
  calls = [];
  is("givenBack: pending is not given back", await givenBack(ACCOUNT, payment(2500)), false);
  is("givenBack asked Stripe for the charge's own refunds", calls.some((call) => call.startsWith("/refunds?") && call.includes(`charge=${CHARGE}`)), true);
  is("purchaseRefunded: pending keeps the purchase", await purchaseRefunded(ACCOUNT, session(2500)), false);
  chargeRefunds = { object: "list", data: [refund("re_refundd18act001", "requires_action", 2500)], has_more: false };
  is("purchaseRefunded: requires_action keeps the purchase", await purchaseRefunded(ACCOUNT, session(2500)), false);

  part("A door: once the refund succeeded, the purchase is given back");
  chargeRefunds = { object: "list", data: [refund("re_refundd18pend01", "succeeded", 2500)], has_more: false };
  is("givenBack: succeeded in full is given back", await givenBack(ACCOUNT, payment(2500)), true);
  is("purchaseRefunded: succeeded in full closes the door", await purchaseRefunded(ACCOUNT, session(2500)), true);
  calls = [];
  // Rule 23 (pre-review of 89b127cfbd, LEVE 5): nothing is kept between readings any more, so a refund that failed
  // after it succeeded counts at once; before, a day-long mark answered with no read ([true, 0]).
  is("asked again on the next reading, nothing kept from the last", [await givenBack(ACCOUNT, payment(2500)), calls.filter((call) => call.startsWith("/refunds")).length], [true, 1]);
  calls = [];
  const expanded = { ...payment(2500), latest_charge: { ...(payment(2500).latest_charge as object), refunds: { object: "list", data: [refund("re_refundd18pend01", "succeeded", 2500)], has_more: false } } };
  is("refunds expanded on the charge decide with no read", [await givenBack(ACCOUNT, expanded), calls.filter((call) => call.startsWith("/refunds")).length], [true, 0]);

  // Each scenario starts with an empty store (the alert marks of lib/refunds.ts).
  redis.clear();
  part("A refund in parts");
  chargeRefunds = { object: "list", data: [refund("re_refundd18part02", "pending", 1500), refund("re_refundd18part01", "succeeded", 1000, NOW - 120)], has_more: false };
  is("a succeeded part plus a pending part does not give back", await givenBack(ACCOUNT, payment(2500)), false);
  is("purchaseRefunded: the rest still pending keeps the purchase", await purchaseRefunded(ACCOUNT, session(2500)), false);
  chargeRefunds = { object: "list", data: [refund("re_refundd18part02", "succeeded", 1500), refund("re_refundd18part01", "succeeded", 1000, NOW - 120)], has_more: false };
  is("succeeded parts adding up to the charge give back", await givenBack(ACCOUNT, payment(2500)), true);
  chargeRefunds = { object: "list", data: [refund("re_refundd18part03", "failed", 1500), refund("re_refundd18part02", "succeeded", 1500), refund("re_refundd18part01", "succeeded", 1000, NOW - 120)], has_more: false };
  is("a failed part beside succeeded parts that add up still gives back", await givenBack(ACCOUNT, payment(2500)), true);

  // Each scenario starts with an empty store (the alert marks of lib/refunds.ts).
  redis.clear();
  part("Unknown never takes access away and is never a no");
  chargeRefunds = { object: "list", data: [refund("re_refundd18pend01", "succeeded", 2500)], has_more: true };
  is("purchaseRefunded: a list not read whole keeps the purchase", await purchaseRefunded(ACCOUNT, session(2500)), false);
  let threw = false;
  try {
    await givenBack(ACCOUNT, payment(2500));
  } catch {
    threw = true;
  }
  is("givenBack: a list not read whole is unknown (throws), never a no", threw, true);
  chargeRefunds = { object: "list", data: [{ id: "re_refundd18odd001", object: "refund", status: "succeeded", amount: 2500, created: NOW, charge: "ch_someoneelse0001" }], has_more: false };
  is("purchaseRefunded: another charge's refund decides nothing", await purchaseRefunded(ACCOUNT, session(2500)), false);
  chargeRefunds = null;
  is("purchaseRefunded: an answer in another shape keeps the purchase", await purchaseRefunded(ACCOUNT, session(2500)), false);

  // Each scenario starts with an empty store (the alert marks of lib/refunds.ts).
  redis.clear();
  part("A booked call keeps its time while its full refund is on its way (lib/calls.ts)");
  const start = Date.now() + 3 * 86_400_000;
  booking = { id: BOOKING, object: "checkout.session", status: "complete", payment_status: "paid", amount_total: 2500, currency: "usd", metadata: { kind: "call", store: "d18calls", start: String(start), end: String(start + 1_800_000) }, payment_intent: payment(2500) };
  chargeRefunds = { object: "list", data: [refund("re_refundd18call01", "pending", 2500)], has_more: false };
  is("a booking whose full refund is pending keeps its time", (await paidCall(callStore, BOOKING))?.session ?? null, BOOKING);
  chargeRefunds = { object: "list", data: [refund("re_refundd18call01", "succeeded", 2500)], has_more: false };
  is("once the refund succeeded, the time is free", await paidCall(callStore, BOOKING), null);

  // Each scenario starts with an empty store (the alert marks of lib/refunds.ts).
  redis.clear();
  part("Controls: a refund failed or canceled keeps access, and an unrefunded payment needs no extra read");
  calls = [];
  is("givenBack: the charge no longer reads refunded", await givenBack(ACCOUNT, payment(0)), false);
  is("purchaseRefunded: the charge no longer reads refunded", await purchaseRefunded(ACCOUNT, session(0)), false);
  is("no read of the refunds for a payment Stripe does not mark refunded", calls.filter((call) => call.startsWith("/refunds")).length, 0);

  part("Pending for more than seven days: an alert, at most once a charge a day, never a revocation");
  const said: string[] = [];
  const errors = console.error;
  console.error = (...args: unknown[]) => {
    said.push(args.map(String).join(" "));
  };
  chargeRefunds = { object: "list", data: [refund("re_refundd18old001", "pending", 2500, NOW - 8 * 86_400)], has_more: false };
  const stuck = (await purchaseRefunded(ACCOUNT, session(2500))) === false;
  const again = (await purchaseRefunded(ACCOUNT, session(2500))) === false;
  console.error = errors;
  const alerts = said.filter((line) => line.includes("more than seven days"));
  is("a refund pending eight days keeps the purchase, twice", [stuck, again], [true, true]);
  is("it is said once, not on every read the same day", alerts.length, 1);
  is("the alert names the charge", alerts[0]?.includes(CHARGE) ?? false, true);
  said.length = 0;
  console.error = (...args: unknown[]) => {
    said.push(args.map(String).join(" "));
  };
  chargeRefunds = { object: "list", data: [refund("re_refundd18new001", "pending", 2500, NOW - 86_400)], has_more: false };
  // Nothing said today yet, so only the age decides.
  redis.clear();
  await purchaseRefunded(ACCOUNT, session(2500));
  console.error = errors;
  is("control: a refund pending one day is not said", said.filter((line) => line.includes("more than seven days")).length, 0);

  done();
}

void main();
