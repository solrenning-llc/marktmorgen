/**
 * 513 [PF1], left over from the review of 5 November 2026 (CX-123, rule 24):
 * the reminders about one product (a checkout left unpaid, a reminder the
 * buyer asked for, the Store assistant's reminder) never write about a
 * limited product whose count could not be read, as the cart's reminder
 * already does. "Unknown" is never taken for "some left": a buyer is not
 * sent back to something that may be sold out. A count that was read still
 * decides as before: none left is skipped, some left is sent. Stripe and the
 * sender are stand-ins for `fetch`; nothing real is reached.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductExtras, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { remindAbandoned, remindAsked, remindAssisted } from "@/lib/checkout-recovery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_unknown_stock_only";
// A stand-in key from tests/resend-fixture-credentials.ts, shared with the other reminder tests.
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";

const OWNER = "printer@example.com";
const emails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[] };
    emails.push([body.to].flat()[0]);
    return answer({ id: `email_${emails.length}` });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${new URL(String(input)).pathname}` } }, 404);
}) as typeof fetch;

// The stock is read with HGETALL on the product's own stock key; every other
// command reaches the stand-in Redis unchanged.
type Answer = "real" | "throws" | "odd";
let answer: Answer = "real";
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const asksStock = commands.some((command) => command[0] === "HGETALL" && /^nl:stock:(?!lock:)/.test(String(command[1])));
  if (!asksStock || answer === "real") return realPipeline(commands);
  if (answer === "throws") throw new Error("Synthetic Redis failure reading the stock");
  const replies = await realPipeline(commands);
  return replies.map((reply, i) => (commands[i][0] === "HGETALL" && /^nl:stock:(?!lock:)/.test(String(commands[i][1])) ? ["only-a-key"] : reply));
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "printworks", "Print Works", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPrint00001", true);
  await setSubscription(OWNER, { customerId: "cus_Print00001", subscriptionId: "sub_Print00001", active: true, period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "9 Press Lane, Portland, OR 97201", asks: true });
  const made = await addProduct(OWNER, "Signed Print", "", "40", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/print");
  const limited = await setProductExtras(OWNER, made.product.id, { stock: 5 });
  is("the product is limited to five", limited.ok, true);
  const print = made.product.id;
  const load = async () => (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  const left = (id: string, email: string) =>
    ({
      id,
      object: "checkout.session",
      status: "expired",
      payment_status: "unpaid",
      created: now - 3700,
      expires_at: now - 100,
      consent: { promotions: "opt_in" },
      customer_details: { email },
      metadata: { store: "printworks", product: print },
    }) as never;
  let n = 0;
  const three = async (as: Answer) => {
    answer = as;
    n += 1;
    const before = emails.length;
    const got = [
      await remindAbandoned(await load(), left(`cs_test_unknownstock${String(n).padStart(4, "0")}a`, `left${n}@example.com`)),
      await remindAsked(await load(), { productId: print, email: `asked${n}@example.com`, askedAt: now - 3600, key: `k${n}` }),
      await remindAssisted(await load(), left(`cs_test_unknownstock${String(n).padStart(4, "0")}b`, `assisted${n}@example.com`), { email: `assisted${n}@example.com`, why: "You asked for this reminder." }),
    ];
    answer = "real";
    return [got, emails.length - before];
  };

  part("A count that could not be read never sends a reminder about it");
  is("the stock fails to load: none of the three is sent", await three("throws"), [["skip", "skip", "skip"], 0]);
  is("the stock answers in a shape that is not a record: none of the three is sent", await three("odd"), [["skip", "skip", "skip"], 0]);

  part("A count that was read decides as before");
  is("some left: all three are sent", await three("real"), [["sent", "sent", "sent"], 3]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
