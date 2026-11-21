/**
 * The quiet-sales email is never sent, and its sent mark never written, for a store whose erasure began while its sales
 * were being read (Codex L-20261120-1852): checkQuiet takes nl:quiet:sent:<handle>:<last> after up to three Stripe
 * pages on an old Store, so it takes it through claimWhileStoreLive (lib/store-live-cache.ts). Synthetic store, the
 * in-memory Redis and stubbed Stripe and email only.
 */
import { checkQuiet } from "@/lib/quiet-sales";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_quiet_erasure";
process.env.RESEND_API_KEY = "re_test_quiet_coverage";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const now = Date.now();
const day = 86_400_000;
let handle = "";
let emails = 0;
/** Run once, inside the first Stripe read, while checkQuiet still holds the old Store. */
let during: (() => Promise<void>) | null = null;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails += 1;
    return new Response(JSON.stringify({ id: `email_${emails}` }), { status: 200 });
  }
  const step = during;
  during = null;
  if (step) await step();
  const data = Array.from({ length: 30 }, (_, i) => ({ id: `cs_${i}`, created: (now - (20 + i) * day) / 1000, status: "complete", payment_status: "paid", metadata: { store: handle } }));
  return new Response(JSON.stringify({ data, has_more: false }));
}) as typeof fetch;

async function seed(owner: string, name: string): Promise<Store> {
  redis.clear();
  handle = name;
  await claimHandle(owner, name, "Quiet Erasure", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1SyntheticQuiet", true);
  // A paid plan, kept: the email is metered on the store's own allowance.
  await setSubscription(owner, { customerId: `cus_${name}`, subscriptionId: `sub_${name}`, active: true, period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

// The last sale is the newest of the stubbed history, 20 days back: its sent mark is keyed by that time.
const sentMarks = () => (Number(redis.run(["EXISTS", `nl:quiet:sent:${handle}:${now - 20 * day}`])) === 1 ? ["kept"] : []);

async function main(): Promise<void> {
  part("A live store gets its one email");
  emails = 0;
  const live = await seed("quiet-live@example.com", "quietlive");
  const o1 = await checkQuiet(live, now);
  is("sent", o1, "sent");
  is("one email", emails, 1);
  is("its sent mark is kept", sentMarks().length, 1);

  part("An erasure that begins during the Stripe read: no mark, no email");
  emails = 0;
  const store = await seed("quiet-erased@example.com", "quieterased");
  during = async () => {
    await redis.pipeline([
      ["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())],
      ["DEL", storeIdCommand(store.sid)[1]],
    ]);
  };
  is("not sent", (await checkQuiet(store, now)) === "sent", false);
  is("no email to the erased store's old address", emails, 0);
  is("no sent mark recreated", sentMarks().length, 0);

  part("Erasing but the record still there: the same");
  emails = 0;
  const marked = await seed("quiet-marked@example.com", "quietmarked");
  during = async () => {
    await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(marked)), String(Date.now())]]);
  };
  is("not sent", (await checkQuiet(marked, now)) === "sent", false);
  is("no email", emails, 0);
  is("no sent mark", sentMarks().length, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
