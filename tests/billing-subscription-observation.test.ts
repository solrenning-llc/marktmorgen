import { readSubscription } from "@/lib/billing";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_subscription_observation_only";
const id = "sub_ReadObservation01";
let payload: unknown;
let status = 200;
let calls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== `/v1/subscriptions/${id}` || init?.method !== "GET")
    throw new Error("unexpected synthetic subscription read");
  calls += 1;
  return Response.json(payload, { status });
}) as typeof fetch;

async function main() {
  part("An unknown read cannot end or activate another subscription");
  const bad: unknown[] = [null, [], {}, { status: "canceled" },
    { id: "sub_AnotherRead01", status: "canceled" },
    { id: "sub_AnotherRead01", status: "active" },
    { id, status: null }, { id, status: "" }, { id, status: "future_unknown" }];
  for (const value of bad) {
    payload = value; calls = 0;
    is("ambiguous observation remains unknown", await readSubscription(id), { state: "unknown" });
    is("no retry or fallback request is made", calls, 1);
  }
  for (const state of ["canceled", "incomplete_expired", "paused", "unpaid", "incomplete"]) {
    payload = { id, status: state };
    is("an identified inactive observation is preserved", await readSubscription(id), { state: "inactive", reason: state });
  }
  payload = { id, status: "active", cancel_at_period_end: false };
  is("an identified active observation without its plan line is unknown (CX-123 rule 24)", await readSubscription(id), { state: "unknown" });
  payload = { id, status: "active", cancel_at_period_end: false, cancel_at: null,
    items: { object: "list", data: [{ price: { unit_amount: 6900, recurring: { interval: "month", interval_count: 1 } } }] } };
  is("an identified legacy active observation with its plan line remains available", (await readSubscription(id)).state, "active");
  status = 404; payload = { error: { message: "not found" } };
  is("an explicit provider missing response remains missing", await readSubscription(id), { state: "inactive", reason: "missing" });
  status = 500; payload = { error: { message: "unavailable" } };
  is("provider unavailability is still unknown", await readSubscription(id), { state: "unknown" });
  done();
}
main();
