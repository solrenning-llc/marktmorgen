import assert from "node:assert/strict";
import { setCancelAtPeriodEnd } from "@/lib/billing";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cancellation_observation_only";
const id = "sub_CancelObservation01";
/** The one plan line Stripe sends with every subscription in good standing. */
const line = { items: { object: "list", data: [{ price: { unit_amount: 6900, recurring: { interval: "month", interval_count: 1 } } }] } };
let payload: unknown;
const calls: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== `/v1/subscriptions/${id}` || init?.method !== "POST")
    throw new Error("unexpected synthetic cancellation operation");
  calls.push(new URLSearchParams(String(init.body)));
  return Response.json(payload);
}) as typeof fetch;

async function main() {
  part("Unknown cancellation observations cannot confirm ended or resumed access");
  const bad: unknown[] = [null, [], {}, { status: "canceled" },
    { id: "sub_OtherSubscription01", status: "active", cancel_at_period_end: true },
    { id, status: null }, { id, status: "" }, { id, status: "future_unknown" },
    { id, status: "active" }, { id, status: "active", cancel_at_period_end: "true" }];
  for (const value of bad) {
    payload = value; calls.length = 0;
    await assert.rejects(setCancelAtPeriodEnd(id, true));
    is("unknown state makes no fallback or retry", calls.length, 1);
  }
  for (const cancel of [false, true]) {
    payload = { id, status: "active", cancel_at_period_end: !cancel, cancel_at: null, ...line };
    await assert.rejects(setCancelAtPeriodEnd(id, cancel), /acknowledge/);
    payload = { id, status: "active", cancel_at_period_end: cancel, cancel_at: null, ...line };
    const state = await setCancelAtPeriodEnd(id, cancel);
    is("the explicit active setting is preserved", state.state === "active" && state.cancelsAtEnd, cancel);
    is("the requested setting is sent unchanged", calls[calls.length - 1].get("cancel_at_period_end"), String(cancel));
  }
  payload = { id, status: "active", cancel_at_period_end: false, cancel_at: Math.floor(Date.now()/1000) + 86400, ...line };
  await assert.rejects(setCancelAtPeriodEnd(id, false), /acknowledge/);
  for (const status of ["canceled", "incomplete_expired", "paused", "unpaid", "incomplete"]) {
    payload = { id, status };
    is("an explicit identified inactive state is preserved", await setCancelAtPeriodEnd(id, true), { state: "inactive", reason: status });
  }
  done();
}
main();
