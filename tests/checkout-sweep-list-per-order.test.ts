/**
 * The buyer-list loop of the checkout sweep (lib/checkout-sweep.ts): one order whose products cannot be read never
 * holds back the orders behind it (Claude 4, C4-2990). Order A, already confirmed on its thanks page, bought a hidden
 * product, whose record is read from Redis; that read throws while it lasts. B, the older order, bought a visible
 * one. Before the per-order catch, A's throw ended the store's pass: B was never put on the list, and the run said
 * nothing had failed. Real sweep on the in-memory Redis; Stripe's list stubbed.
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { listingKeysRead } from "./listing-reads";
import { installSesMailFixture } from "./ses-mail-fixture";

let sessions: unknown[] = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_conditions_only_a_stand_in";

  const OWNER = "sweep-list-catch@example.com";
  await claimHandle(OWNER, "sweeplist", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSwpLst1", true);
  await setSubscription(OWNER, { customerId: "cus_SwpLst1", subscriptionId: "sub_SwpLst1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const hidden = await addProduct(OWNER, "Private Course", "Sold by link.", "49", null);
  const shown = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!hidden.ok || !shown.ok) throw new Error("no product");
  await setProductLink(OWNER, hidden.product.id, "https://example.com/private");
  await setProductLink(OWNER, shown.product.id, "https://example.com/course");
  await setProductHidden(OWNER, hidden.product.id, true);
  await storeForEmail(OWNER);
  const paid = (id: string, email: string, product: string, age: number) => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - age, amount_total: 4900, currency: "usd",
    customer_details: { email }, metadata: { store: "sweeplist", product },
  });
  const A = "cs_test_sweeplistA00000001", B = "cs_test_sweeplistB00000001";
  sessions = [paid(A, "ann@example.com", hidden.product.id, 60), paid(B, "bob@example.com", shown.product.id, 600)];
  // A's confirmation went from its thanks page, so the confirmation loop leaves it and only the list reads its product.
  await redis.pipeline([["SET", `nl:confirm:${A}`, "1"]]);

  const real = redis.pipeline.bind(redis);
  let throws = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => listingKeysRead(c).some((key) => key.endsWith(`:l:${hidden.product.id}`)))) {
      throws += 1;
      throw new Error("a record that does not read");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const errors = console.error;
  console.error = () => undefined;
  const listed = async (id: string) => Number((await real([["EXISTS", `nl:listed:${id}`]]))[0]);

  part("A's product cannot be read while the list loop runs");
  let counts = await sweepCheckouts(Date.now() + 20_000);
  is("the throw happened (the test reaches the list loop's read)", throws > 0, true);
  is("B, behind A, is put on the list, and the run counts it", [await listed(B), counts.listed], [1, 1]);
  is("A is not, and stays unmarked for the next run", await listed(A), 0);
  is("A is counted as failed", counts.failed, 1);
  is("B's confirmation went", mail.ses.filter((m) => m.to.includes("bob@example.com")).length, 1);
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("a second run with the throw: A still unmarked and counted as failed, B not listed twice", [await listed(A), counts.failed, counts.listed], [0, 1, 0]);

  part("The read comes back");
  redis.pipeline = real;
  counts = await sweepCheckouts(Date.now() + 20_000);
  console.error = errors;
  is("A, kept for the next run, is put on the list then", [await listed(A), counts.listed, counts.failed], [1, 1, 0]);

  part("An order whose products cannot be read in both loops is one failed order, not two (Claude 5 on #2977)");
  // C, not yet confirmed, bought the hidden product: its confirmation reads that product and throws, and so does the
  // list's read of it. It is one order that failed, counted once, and it stays unmarked in both for the next run.
  const C = "cs_test_sweeplistC00000001";
  sessions = [paid(C, "cat@example.com", hidden.product.id, 30), ...sessions];
  throws = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => listingKeysRead(c).some((key) => key.endsWith(`:l:${hidden.product.id}`)))) {
      throws += 1;
      throw new Error("a record that does not read");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  console.error = () => undefined;
  counts = await sweepCheckouts(Date.now() + 20_000);
  redis.pipeline = real;
  console.error = errors;
  is("both loops threw on C (its confirmation and its list read)", throws >= 2, true);
  is("C is counted as failed once", counts.failed, 1);
  is("C is neither confirmed nor listed, so the next run tries both", [Number((await real([["EXISTS", `nl:confirm:${C}`]]))[0]), await listed(C), mail.ses.filter((m) => m.to.includes("cat@example.com")).length], [0, 0, 0]);
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("the read back, C is confirmed and listed on the next run", [counts.confirmed, counts.listed, counts.failed, await listed(C)], [1, 1, 0, 1]);
  done();
}

void main();
