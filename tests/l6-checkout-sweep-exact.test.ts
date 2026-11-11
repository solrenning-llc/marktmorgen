/**
 * CX-123 rule 24, lot L6 (C4-20261105-1945-C2-2 (5)): the checkout sweep
 * (lib/checkout-sweep.ts) decides from Redis marks whether a paid order's
 * confirmation still has to go, and whether an abandoned checkout's workflows
 * were already started. A mark answered in an unknown shape never counts as
 * "not sent yet" or "ours": nothing is sent on it this run, and the next run,
 * on a whole reading, sends it once. A page of checkouts that is not a list
 * is not taken as "no checkouts". Replies the stand-in never gives by itself
 * are injected for one command only, after it ran.
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

let sessions: unknown = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") {
      return new Response(JSON.stringify(Array.isArray(sessions) ? { object: "list", data: sessions, has_more: false } : sessions));
    }
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

/** Runs `run` with the reply to the first pipeline whose first command is `name` on a key starting `keyPrefix` replaced, after it ran. */
async function withReply(name: string, reply: (real: unknown) => unknown, run: () => Promise<unknown>, keyPrefix = "nl:confirm:"): Promise<void> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await real(commands);
    if (!used && commands[0]?.[0] === name && String(commands[0]?.[1] ?? "").startsWith(keyPrefix)) {
      used = true;
      return reply(answer);
    }
    return answer;
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

  const OWNER = "l6-sweep@example.com";
  await claimHandle(OWNER, "lsixsweep", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLsixSwp1", true);
  await setSubscription(OWNER, { customerId: "cus_LsixSweep1", subscriptionId: "sub_LsixSweep1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const course = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!course.ok) throw new Error("no product");
  await setProductLink(OWNER, course.product.id, "https://example.com/course");
  await storeForEmail(OWNER);
  const paid = (id: string, email: string) => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 600, amount_total: 4900, currency: "usd",
    customer_details: { email }, metadata: { store: "lsixsweep", product: course.product.id },
  });
  const confirmations = (to: string) => mail.ses.filter((m) => m.to.includes(to)).length;

  part("Was the confirmation already sent? Only an exact 0 says no");
  sessions = [paid("cs_test_lsixsweep00000001", "ann@example.com")];
  // Each run that cannot read the mark says so in its failed count (Claude 3 on #2714): past the confirmation window
  // the order is not read again, so a silent skip would be a confirmation never sent and never noticed.
  let said = { failed: -1 };
  await withReply("EXISTS", () => [undefined], async () => (said = await sweepCheckouts(Date.now() + 20_000)));
  is("a mark read in an unknown shape (no answer) sends nothing this run, and the run counts it as failed", [confirmations("ann@example.com"), said.failed], [0, 1]);
  await withReply("EXISTS", () => ["1"], async () => (said = await sweepCheckouts(Date.now() + 20_000)));
  is("nor one answered as text, counted as failed", [confirmations("ann@example.com"), said.failed], [0, 1]);
  await withReply("EXISTS", (real) => [...(real as unknown[]), 0], async () => (said = await sweepCheckouts(Date.now() + 20_000)));
  is("nor an answer with more replies than were asked, counted as failed", [confirmations("ann@example.com"), said.failed], [0, 1]);
  await sweepCheckouts(Date.now() + 20_000);
  is("an exact answer on the next run sends it, once", confirmations("ann@example.com"), 1);
  await sweepCheckouts(Date.now() + 20_000);
  is("and never again", confirmations("ann@example.com"), 1);

  part("A page of checkouts that is not a list is not \"no checkouts\"");
  sessions = { object: "list" };
  let failed = false;
  const errors = console.error;
  console.error = () => {
    failed = true;
  };
  try {
    await sweepCheckouts(Date.now() + 20_000);
  } finally {
    console.error = errors;
  }
  is("it is said to have failed, so the run is not taken as a clean read", failed, true);
  done();
}

void main();
