/**
 * The abandoned-checkout workflows (lib/checkout-sweep.ts, startAbandonedWorkflows) are handed on once per
 * checkout by the mark nl:wf:abandoned:<session>. Found on the review of #2877: the mark counted as ours only on
 * an exact "OK", with no reading back, so a SET NX that landed but whose answer was lost left the mark for two
 * days against the sweep's six-hour window: every later run read it as taken and that checkout's workflow never
 * started. Now the claim is lib/claim-mark.ts: a lost answer is read back (our own value there is ours), an
 * unknown one starts nothing and lets go of the mark only while it still holds this run's value, so the next run
 * tries again; a mark written by the old code ("1") is still somebody else's.
 *
 * Driven through the real sweepCheckouts, with Stripe's checkout list and SES stood in; replies the stand-in never
 * gives by itself are injected for one command only, after it ran (or instead of it, for a write never made).
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { upsertContact } from "@/lib/contacts";
import { saveFlow } from "@/lib/flows";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

const MARK = "nl:wf:abandoned:";
let sessions: unknown[] = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

type Rule = { name: string; mode: "lost" | "throw-unapplied"; used?: boolean };

/** Runs `run` with each rule applied once, to the first pipeline whose first command is `name` on a mark key. */
async function withRules(rules: Rule[], run: () => Promise<unknown>): Promise<void> {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const rule = rules.find((r) => !r.used && commands[0]?.[0] === r.name && String(commands[0]?.[1] ?? "").startsWith(MARK));
    if (!rule) return real(commands);
    rule.used = true;
    if (rule.mode === "throw-unapplied") throw new Error("connection reset before the command was sent");
    await real(commands);
    return [undefined];
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_conditions_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_conditions_only_a_stand_in";
  const errors = console.error;
  console.error = () => {};

  const OWNER = "abandoned-claim@example.com";
  await claimHandle(OWNER, "abandonclaim", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestAbnClm1", true);
  await setSubscription(OWNER, { customerId: "cus_AbnClaim1", subscriptionId: "sub_AbnClaim1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const made = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!made.ok) throw new Error("no product");
  const product = made.product;
  await setProductLink(OWNER, product.id, "https://example.com/course");
  const store = (await storeForEmail(OWNER))!;
  const flow = await saveFlow(store, { name: "Cart", trigger: "abandoned", productId: product.id, goal: { productId: product.id }, active: true, steps: [{ delayHours: 1, subject: "Still thinking?", body: "Your cart is here." }] }, { activate: true });
  if (!flow.ok) throw new Error(`no flow: ${JSON.stringify(flow)}`);

  let serial = 0;
  /** A buyer on the creator's list and their closed, unpaid checkout of ten minutes ago. */
  async function checkout(): Promise<{ id: string; email: string }> {
    serial += 1;
    const email = `cart${serial}@example.com`;
    const id = `cs_test_abandonclaim${String(serial).padStart(6, "0")}`;
    await upsertContact(store.listId!, email, { agreed: true, explicit: true, productId: product.id, title: product.title, source: "buyer" }, store);
    const now = Math.floor(Date.now() / 1000);
    sessions = [{
      id, object: "checkout.session", status: "expired", payment_status: "unpaid", mode: "payment",
      created: now - 3_600, expires_at: now - 600, amount_total: 4900, currency: "usd",
      consent: { promotions: "opt_in" }, customer_details: { email }, metadata: { store: "abandonclaim", product: product.id },
    }];
    return { id, email };
  }
  const started = (email: string) => ((redis.run(["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]) as string[]) ?? []).filter((m) => m.endsWith(`|${email}`)).length;
  const sweep = () => sweepCheckouts(Date.now() + 20_000);

  try {
    part("A healthy claim starts the workflow once");
    const healthy = await checkout();
    await sweep();
    is("the first run starts it", started(healthy.email), 1);
    await sweep();
    is("and a later run does not start it again", started(healthy.email), 1);

    part("The mark landed but its answer was lost: read back, it is ours");
    const lost = await checkout();
    await withRules([{ name: "SET", mode: "lost" }], sweep);
    is("this run starts it, since the key holds this run's own value", started(lost.email), 1);
    await sweep();
    is("and the next run does not start it a second time", started(lost.email), 1);

    part("The mark landed, its answer and the reading back were both lost: unknown");
    const unknown = await checkout();
    await withRules([{ name: "SET", mode: "lost" }, { name: "GET", mode: "lost" }], sweep);
    is("this run starts nothing on it", started(unknown.email), 0);
    is("and lets go of its own mark, so it does not sit there for two days", redis.run(["EXISTS", `${MARK}${unknown.id}`]), 0);
    await sweep();
    is("the next run, on a whole reading, starts it once", started(unknown.email), 1);
    await sweep();
    is("and never again", started(unknown.email), 1);

    part("The write never reached Redis: unknown, and the next run tries");
    const unsent = await checkout();
    await withRules([{ name: "SET", mode: "throw-unapplied" }], sweep);
    is("this run starts nothing", started(unsent.email), 0);
    await sweep();
    is("the next run starts it once", started(unsent.email), 1);

    part("A mark another run wrote, old style or new, is somebody else's");
    const old = await checkout();
    redis.run(["SET", `${MARK}${old.id}`, "1", "EX", 2 * 86_400]);
    await sweep();
    is("an old \"1\" mark starts nothing", started(old.email), 0);
    is("and is left where it is", redis.run(["GET", `${MARK}${old.id}`]), "1");
    const other = await checkout();
    redis.run(["SET", `${MARK}${other.id}`, "1730000000000.000000001", "EX", 2 * 86_400]);
    await sweep();
    is("another run's claim starts nothing either", started(other.email), 0);
    is("and is not let go by this run", redis.run(["GET", `${MARK}${other.id}`]), "1730000000000.000000001");
  } finally {
    console.error = errors;
  }
  done();
}

void main();
