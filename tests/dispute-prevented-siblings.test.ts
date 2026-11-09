/**
 * The siblings of #3318 in lib/refunds.ts (rule 30): every door that reads a
 * Stripe dispute's status reads `prevented` and the legacy `charge_refunded`
 * as money given back to the buyer, exactly as `lost`; `won` and
 * `warning_closed` give nothing back; the open stages are still open; a
 * status Stripe does not give is never passed over (disputeLost throws, the
 * sweep stops incomplete).
 *
 * On main the doors (lostOnCharge, closingKnown, disputeLost, rowGivesBack,
 * lostDisputesSince) closed only on `lost`, so a buyer whose dispute was
 * prevented had the money back and kept the access. The numbers
 * (lib/retained-revenue.ts) and the share job (lib/share-settle.ts) are
 * #3321's.
 *
 * Synthetic Stripe only: no real account, no real money.
 */
import { disputeLost, lostDisputesSince, refundedInFull, rowGivesBack } from "@/lib/refunds";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_c5_prevented_siblings";

const CHARGE = "ch_C5Prevented01";
const RETURNED = ["lost", "prevented", "charge_refunded"];
const NOT_RETURNED = ["won", "warning_closed", "needs_response", "under_review", "warning_needs_response", "warning_under_review"];

/** What the synthetic Stripe answers on each path; set per case. */
let disputes: unknown = { object: "list", has_more: false, data: [] };
let events: unknown = { object: "list", has_more: false, data: [] };

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  if (url.pathname === "/v1/disputes") return Response.json(disputes);
  if (url.pathname === "/v1/events") return Response.json(events);
  return new Response(JSON.stringify({ error: { message: "unexpected synthetic endpoint" } }), { status: 404 });
}) as typeof fetch;

const payment = { object: "payment_intent", latest_charge: { object: "charge", id: CHARGE, refunded: false, amount: 5000, amount_refunded: 0, disputed: true } };
const row = (status: unknown) => ({ id: "du_C5Prevented01", object: "dispute", status, charge: CHARGE });

/** What a reading answers, or "threw": a failing case is counted, never the end of the run. */
async function settled(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch {
    return "threw";
  }
}

async function rejects(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function doors() {
  part("lib/refunds.ts: a dispute whose money went back closes the doors, whatever Stripe calls it");
  for (const status of RETURNED) {
    disputes = { object: "list", has_more: false, data: [row(status)] };
    is(`disputeLost: ${status} gives the money back`, await settled(() => disputeLost("acct_C5Prevented", payment)), true);
    const built = { ...payment.latest_charge, dispute: { status } };
    is(`refundedInFull: a row the sweep built for ${status} reads as given back`, refundedInFull(built), true);
    is(`rowGivesBack: a ${status} dispute row takes the sale back`, rowGivesBack({ object: "dispute", id: "evt_C5Prevented01", status, charge: built }), true);
  }
  for (const status of NOT_RETURNED) {
    disputes = { object: "list", has_more: false, data: [row(status)] };
    is(`disputeLost: ${status} gives nothing back`, await settled(() => disputeLost("acct_C5Prevented", payment)), false);
    const built = { ...payment.latest_charge, dispute: { status } };
    is(`rowGivesBack: a ${status} dispute row takes nothing back`, rowGivesBack({ object: "dispute", id: "evt_C5Prevented01", status, charge: built }), false);
  }
  for (const status of ["mystery", "", null, undefined, 7]) {
    disputes = { object: "list", has_more: false, data: [row(status)] };
    is(`disputeLost: a status Stripe does not give (${JSON.stringify(status)}) is never read as "not lost"`, await rejects(() => disputeLost("acct_C5Prevented", payment)), true);
  }
  disputes = { object: "list", has_more: false, data: [row("mystery"), row("prevented")] };
  is("disputeLost: its own returned dispute decides even beside an unknown one", await settled(() => disputeLost("acct_C5Prevented", payment)), true);

  part("lib/refunds.ts lostDisputesSince: the sweep reads every closing that gave the money back");
  const event = (id: string, status: string) => ({ id, created: 1_800_000_000, data: { object: { status, payment_intent: "pi_C5Prevented01", charge: CHARGE } } });
  events = {
    object: "list",
    has_more: false,
    data: [event("evt_C5Lost000001", "lost"), event("evt_C5Prevented01", "prevented"), event("evt_C5ChargeRef01", "charge_refunded"), event("evt_C5Won0000001", "won"), event("evt_C5Closed0001", "warning_closed")],
  };
  const read = await lostDisputesSince("acct_C5Prevented", 0);
  is("lostDisputesSince: reads the whole page", read.complete, true);
  is("lostDisputesSince: lost, prevented and charge_refunded become rows; won and warning_closed do not", read.rows.map((r) => r.id), ["evt_C5Lost000001", "evt_C5Prevented01", "evt_C5ChargeRef01"]);
  is("lostDisputesSince: every row it builds is one the jobs take back", read.rows.every((r) => rowGivesBack(r)), true);
  events = { object: "list", has_more: false, data: [{ id: "evt_C5NoCharge01", created: 1_800_000_000, data: { object: { status: "prevented", payment_intent: "pi_C5Prevented01", charge: null } } }] };
  is("lostDisputesSince: a prevented closing without its charge is unknown, never passed over", (await lostDisputesSince("acct_C5Prevented", 0)).complete, false);
}

async function main() {
  await doors();
}

main().then(done);
