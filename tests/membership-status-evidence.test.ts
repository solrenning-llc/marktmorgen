import { membershipStatus } from "@/lib/membership-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { cachedReply } from "./membership-status-redis";
import { store as memory } from "./redis-stub";
import { done, is, part } from "./check";

const store = { stripeAccountId: "acct_1TestClub000001" } as Store;
const sub = "sub_Member000001";
const savedFetch = globalThis.fetch;
const savedKey = process.env.STRIPE_SECRET_KEY;
let reads = 0;
let providerBody: unknown = { id: sub, status: "active", pause_collection: null };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com" || url.pathname !== `/v1/subscriptions/${sub}` || init?.method !== "GET") throw Error("Unexpected provider operation");
  reads += 1;
  return new Response(JSON.stringify(providerBody));
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_pause_only_a_stand_in";
  part("An unconfirmed cache read cannot become an ended membership");
  for (const [name, reply] of [
    ["empty reply", []], ["missing reply", undefined], ["null reply", null],
    ["missing result", [undefined]], ["boolean result", [false]], ["numeric result", [1]],
    ["object result", [{}]], ["empty status", [""]],
    ["extra active result", ["active", "extra"]], ["extra missing result", [null, "extra"]],
  ] as const) {
    memory.clear(); cachedReply(reply); reads = 0;
    let error: unknown;
    try { await membershipStatus(store, sub); } catch (caught) { error = caught; }
    is(`${name}: unknown throws, with no provider read or stored status`, [error instanceof UnknownReplyError, reads, memory.keys().length], [true, 0, 0]);
  }

  part("A confirmed hit and an explicit miss keep the paid grace period");
  for (const status of ["active", "trialing", "past_due", "canceled", "paused"]) {
    cachedReply([status]); reads = 0;
    is(`${status}: use the one confirmed status`, [await membershipStatus(store, sub), reads], [status, 0]);
  }
  memory.clear(); cachedReply([null]); reads = 0;
  providerBody = { id: sub, status: "active", pause_collection: null };
  is("an explicit missing key permits the existing provider read", [await membershipStatus(store, sub), reads], ["active", 1]);
  cachedReply();
  is("the provider's known answer is kept by the existing cache", [await membershipStatus(store, sub), reads], ["active", 1]);

  part("An unidentified provider reply cannot become an ended membership");
  memory.clear(); cachedReply([null]); reads = 0;
  providerBody = { status: "active", pause_collection: null };
  let providerError: unknown;
  try { await membershipStatus(store, sub); } catch (caught) { providerError = caught; }
  is("missing provider identity throws and fills no cache", [providerError instanceof UnknownReplyError, reads, memory.keys().length], [true, 1, 0]);
}

void main().finally(() => {
  globalThis.fetch = savedFetch; cachedReply();
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = savedKey;
}).then(done).catch(error => { console.error(error); process.exit(1); });
