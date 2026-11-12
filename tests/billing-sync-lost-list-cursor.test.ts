/**
 * Step 1 of the daily subscription sync (lib/billing-sync.ts, syncListed) keeps the place it reached in Stripe's
 * list of subscriptions, and the next run asks for the page after it (`starting_after`). When Stripe no longer
 * knows that subscription (the key was moved to another account or mode, or the subscription went with its
 * customer), every request with that place is refused with `resource_missing`. The defect this file was written
 * around: the refusal was counted as a failure and the same place was saved again, with a fresh expiry, so step 1
 * never read Stripe's list again — a subscription canceled at Stripe whose store step 2 does not reach on its own
 * was never brought in line, and an unwritten paying one was never adopted. Now a place Stripe says it does not
 * know is dropped and the list is read again from its start, once, in the same run; the run still counts the
 * failure and is not complete. Any other refusal keeps the place, as before. Synthetic data only; no write is sent.
 */
import { syncSubscriptions } from "@/lib/billing-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sync_lost_list_cursor_only";
const CURSOR = "nl:billing:sync:after";
const listCalls: (string | null)[] = [];
/** How Stripe answers a list request that names a place: "missing" (the id is unknown) or "busy" (a 500). */
let placeAnswer: "missing" | "busy" = "missing";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || (init?.method ?? "GET") !== "GET") throw new Error("unexpected external operation in synthetic billing sync");
  if (url.pathname === "/v1/subscriptions") {
    const after = url.searchParams.get("starting_after");
    listCalls.push(after);
    if (after === "sub_FromAnotherMode01") {
      if (placeAnswer === "missing") {
        return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", param: "starting_after", message: "No such subscription: 'sub_FromAnotherMode01'" } }, { status: 400 });
      }
      return Response.json({ error: { type: "api_error", message: "Something went wrong on Stripe's end." } }, { status: 500 });
    }
    return Response.json({ object: "list", data: [], has_more: false });
  }
  throw new Error("unexpected provider path in synthetic billing sync");
}) as typeof fetch;

async function main() {
  part("A saved place Stripe does not know is dropped, and the list is read from its start in the same run");
  redis.clear();
  listCalls.length = 0;
  placeAnswer = "missing";
  await redis.pipeline([["SET", CURSOR, "sub_FromAnotherMode01"]]);
  const first = await syncSubscriptions(Date.now() + 60_000);
  is("the list is asked from the place, then from its start", listCalls, ["sub_FromAnotherMode01", null]);
  is("the unknown place is not kept", (await redis.pipeline([["GET", CURSOR]]))[0], null);
  is("the refusal still counts as a failure and the run is not complete", [first.failed, first.complete], [1, false]);
  listCalls.length = 0;
  const second = await syncSubscriptions(Date.now() + 60_000);
  is("the next run reads the list from its start and completes", [listCalls, second.failed, second.complete], [[null], 0, true]);

  part("Any other refusal keeps the place for the next run, as before");
  redis.clear();
  listCalls.length = 0;
  placeAnswer = "busy";
  await redis.pipeline([["SET", CURSOR, "sub_FromAnotherMode01"]]);
  const busy = await syncSubscriptions(Date.now() + 60_000);
  is("one request, from the place", listCalls, ["sub_FromAnotherMode01"]);
  is("the place is kept", (await redis.pipeline([["GET", CURSOR]]))[0], "sub_FromAnotherMode01");
  is("counted as a failure, not complete", [busy.failed, busy.complete], [1, false]);
  done();
}

main();
