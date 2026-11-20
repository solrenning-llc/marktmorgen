/**
 * Codex N1 on #3929 (MEDIUM, erasure): a cart reminder read the person's deletion print in its first pipeline, then,
 * after the asynchronous paid-since read, wrote the address's carts note and the two claims as separate steps. An
 * erasure that completed in between (print written, forgetRecoveryPerson finding no note yet) was followed by those
 * writes: the note and the once-a-week mark of an erased address were kept, and the reminder could still go out.
 * The note and both claims are now written in one step that reads the print again, and an erased person gets none.
 * Synthetic store, in-memory Redis, stand-in Stripe and email.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { forgetRecoveryPerson, remindAbandoned } from "@/lib/checkout-recovery";
import { suppressCommand } from "@/lib/suppression";
import { createCartCheckout } from "@/lib/cart-checkout";
import { readProduct } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner-race@example.com";
const BUYER = "ana-race@example.com";
const emails: { to: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[] };
    emails.push({ to: [body.to].flat()[0] });
    return answer({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && method === "POST") return answer({ id: `cs_test_${"r".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

type Commands = (string | number)[][];
const keys = async (pattern: string) => ((await redis.pipeline([["SCAN", "0", "MATCH", pattern, "COUNT", 1000]]))[0] as [string, string[]])[1];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_cart_reminder_race_stand_in";
  process.env.RESEND_API_KEY = "re_test_cart_reminder_only";
  await claimHandle(OWNER, "harborrace", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRace01", true);
  await setSubscription(OWNER, { customerId: "cus_OwnerRace01", subscriptionId: "sub_OwnerRace01", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const a = await add("Pantry Guide", "12");
  const b = await add("Grocery Lists", "5");
  await setRecovery(OWNER, { enabled: true, address: "1 Main St, Austin, TX 78701", asks: true });
  const load = async () => (await storeForEmail(OWNER))!;
  await createCartCheckout(await load(), [(await readProduct(await load(), a))!, (await readProduct(await load(), b))!], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  const now = Math.floor(Date.now() / 1000);
  const left = (id: string, email = BUYER) => ({
    id,
    object: "checkout.session",
    status: "expired",
    payment_status: "unpaid",
    created: now - 3700,
    expires_at: now - 100,
    consent: { promotions: "opt_in" },
    customer_details: { email },
    metadata: { store: "harborrace", product: a, bump: b, cart: "yes" },
  });

  part("The person's erasure completes after the reminder read its marks: nothing of them is written, nothing sent");
  const store = await load();
  const real = redis.pipeline.bind(redis);
  let erasedMidway = false;
  redis.pipeline = (async (commands: Commands) => {
    const reply = await real(commands);
    // The reminder's first pipeline (its marks and the deletion print) answered "not erased"; then the erasure runs.
    if (!erasedMidway && commands.some((c) => c[0] === "HEXISTS" && String(c[1]).startsWith("nl:erased:"))) {
      erasedMidway = true;
      await real([suppressCommand(store.listId as string, BUYER)]);
      await forgetRecoveryPerson(store.statsId, [a, b], BUYER);
    }
    return reply;
  }) as typeof redis.pipeline;
  const answer = await remindAbandoned(store, left("cs_test_cartrace000001") as never).finally(() => { redis.pipeline = real; });
  is("the erasure ran between the reminder's read and its writes", erasedMidway, true);
  is("the reminder is skipped, and no email goes to the erased person", [answer, emails.filter((m) => m.to === BUYER).length], ["skip", 0]);
  is("no carts note of the erased address is left", await keys("nl:recover:carts:*"), []);
  is("no once-a-week mark of the erased address is left", await keys("nl:recover:once:*"), []);
  is("no claim is taken for that checkout", await keys("nl:recover:sent:cs_test_cartrace000001"), []);

  part("Control: nobody erased, the same cart is reminded once, with its note and both claims");
  const control = await remindAbandoned(await load(), left("cs_test_cartrace000002", "bo-race@example.com") as never);
  is("sent", [control, emails.length], ["sent", 1]);
  is("its note and its once-a-week mark are written", [(await keys("nl:recover:carts:*")).length, (await keys("nl:recover:once:*")).length], [1, 1]);
  done();
}

void main().catch((error) => { console.error(error); process.exit(1); });
