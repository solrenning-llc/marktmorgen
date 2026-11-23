/**
 * A Stripe refusal answered after the store's erasure began never writes the store's refusal count back, nor takes
 * the day's email mark, nor emails the creator (Codex G-20261119-1221, row 104 of #5010). The count and the mark are
 * written in one step, fenced by the rule of lib/live-fence.ts (store-cache-live:v3): the store's id key must still
 * hold its own ref (for a store kept from before ids, its owner's record must still carry its statsId) and its erasing
 * field must be absent. Synthetic stores, the in-memory Redis and a stand-in email provider only.
 */
import { noteCheckoutTrouble } from "@/lib/checkout-trouble";
import { StripeError } from "@/lib/stripe-account";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.STRIPE_SECRET_KEY = "sk_test_cotrouble_fence_stand_in";
process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
process.env.NIMBUS_DATA_KEY = "tests-only-checkout-trouble-fence-0123456789";
let mails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.resend.com") return Response.json({ object: "list", data: [], has_more: false });
  mails += 1;
  return Response.json({ id: `synthetic_${mails}` });
}) as typeof fetch;

const NOW = Date.UTC(2026, 9, 20, 12);
const DAY = "2026-10-20";
const refused = () => new StripeError(400, "account_invalid", "Synthetic refusal.");
const exists = (key: string) => redis.run(["EXISTS", key]);
const troubleKey = (store: Store) => `nl:cotrouble:${store.statsId}`;
const mailKey = (store: Store) => `nl:cotrouble:mail:${store.statsId}:${DAY}`;

let accounts = 0;
async function shop(email: string, handle: string): Promise<Store> {
  await claimHandle(email, handle, "Trouble shop", "");
  await ensureStoreId(email);
  await ensureStatsId(email);
  // A paid plan, so the store's own emails may be sent (as tests/checkout-trouble-send-unknown.test.ts sets it up).
  await setStripeAccount(email, `acct_1TestCoTrbl${String(++accounts).padStart(4, "0")}`, true);
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, period: paidPeriod() });
  return (await storeForEmail(email))!;
}

/** Nothing of the store's refusals, no day mark and no email. */
async function nothingWritten(label: string, store: Store, run: () => Promise<string>, outcome = "skipped"): Promise<void> {
  mails = 0;
  is(`${label}: ${outcome}`, await run(), outcome);
  is(`${label}: no refusal count, no day mark, no email`, [exists(troubleKey(store)), exists(mailKey(store)), mails], [0, 0, 0]);
}

async function main(): Promise<void> {
  redis.clear();

  part("A live store: counted and the creator told once, as before");
  const live = await shop("trouble-live@example.com", "troublelive");
  mails = 0;
  is("the first refusal of the day emails", await noteCheckoutTrouble(live, refused(), NOW), "emailed");
  is("counted, with the day's mark", [redis.run(["HGET", troubleKey(live), DAY]), exists(mailKey(live)), mails], ["1", 1, 1]);
  is("a second refusal is counted, no second email", [await noteCheckoutTrouble(live, refused(), NOW), redis.run(["HGET", troubleKey(live), DAY]), mails], ["counted", "2", 1]);
  is("a 500 is counted without the email", await noteCheckoutTrouble(live, new StripeError(500, "api_error", "Down."), NOW), "counted");
  is("the count kept its expiry", Number(redis.run(["TTL", troubleKey(live)])) > 0, true);

  part("The store's erasure began while Stripe answered");
  const erasing = await shop("trouble-erasing@example.com", "troubleerasing");
  redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(erasing)), String(NOW)]);
  await nothingWritten("erasing", erasing, () => noteCheckoutTrouble(erasing, refused(), NOW));

  part("The store's erasure ended while Stripe answered (its id key gone)");
  const erased = await shop("trouble-erased@example.com", "troubleerased");
  redis.run(["DEL", storeIdCommand(erased.sid)[1]]);
  await nothingWritten("erased", erased, () => noteCheckoutTrouble(erased, refused(), NOW));

  part("Its id key now names another ref (an account moved)");
  const moved = await shop("trouble-moved@example.com", "troublemoved");
  redis.run(["SET", storeIdCommand(moved.sid)[1], "someone-else@example.com"]);
  await nothingWritten("moved", moved, () => noteCheckoutTrouble(moved, refused(), NOW));

  part("A store from before ids: its owner's record must still be its own");
  const made = await shop("trouble-legacy@example.com", "troublelegacy");
  const legacy: Store = { ...made, sid: "", extra: false };
  is("its own record: counted", await noteCheckoutTrouble(legacy, new StripeError(500, "api_error", "Down."), NOW), "counted");
  redis.run(["DEL", troubleKey(legacy)]);
  const owner = await ownerKey(storeRef(legacy));
  const record = JSON.parse(String(redis.run(["GET", owner]))) as Record<string, unknown>;
  redis.run(["SET", owner, JSON.stringify({ ...record, statsId: "s_another_store_0001" })]);
  await nothingWritten("another store's record under the same key", legacy, () => noteCheckoutTrouble(legacy, refused(), NOW));
  redis.run(["SET", owner, "not json"]);
  await nothingWritten("a record that does not parse", legacy, () => noteCheckoutTrouble(legacy, refused(), NOW));

  part("An answer in another shape never sends the email");
  const lost = await shop("trouble-lost@example.com", "troublelost");
  const real = redis.pipeline.bind(redis);
  for (const reply of [undefined, null, "OK", 3, -9, "2"]) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const out = await real(commands);
      return commands[0]?.[0] === "EVAL" ? [reply] : out;
    }) as typeof redis.pipeline;
    mails = 0;
    try {
      is(`answered ${JSON.stringify(reply)}: counted, no email`, [await noteCheckoutTrouble(lost, refused(), NOW), mails], ["counted", 0]);
    } finally {
      redis.pipeline = real;
    }
  }
  done();
}

void main();
