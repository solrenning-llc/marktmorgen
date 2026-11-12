/**
 * A course bought again after a full refund is noted for the drip job (lib/learn.ts, noteBoughtAgain) through the door
 * every paid checkout goes through (lib/purchase-email.ts, confirmPurchase), whether or not its confirmation email
 * goes, and a note whose write is not known to have landed is never left behind a confirmation kept as sent: the
 * checkout is tried again, and the note with it (Codex G and Codex L on #3369). Without the note, a short course
 * bought again and not opened since never announces its restarted Month 1.
 *
 * Synthetic store, the in-memory Redis and a mocked email provider; nothing real is reached.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { confirmPurchase, confirmationKey } from "@/lib/purchase-email";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let emailsWork = true;
let emails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (!emailsWork) return new Response(JSON.stringify({ message: "synthetic: refused" }), { status: 422 });
    emails += 1;
    return new Response(JSON.stringify({ id: `email_${emails}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

/** The next pipeline holding a command `match` picks never reaches Redis for that command; its reply is `reply`. */
let lost: { match: (command: (string | number)[]) => boolean; reply: unknown } | null = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = async (commands) => {
  const picked = lost;
  const hit = picked ? commands.findIndex(picked.match) : -1;
  if (!picked || hit < 0) return real(commands);
  lost = null;
  const replies = await real(commands.filter((_, i) => i !== hit));
  return [...replies.slice(0, hit), picked.reply, ...replies.slice(hit)];
};

const OWNER = "owner@example.com";
const BUYER = "buyer-again@example.com";
const courseId = "7".repeat(32);
const DAY = 86_400;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_confirm_note_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Drip course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const set = await setProductCourse(OWNER, made.product.id, { id: courseId, lessons: 2 });
  if (!set.ok) throw new Error("no course");
  const store = (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  const before = now - 120 * DAY;
  const checkout = (id: string) => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", currency: "usd",
    amount_total: 4900, created: now, customer_details: { email: BUYER }, metadata: { store: "harbor", product: made.product.id },
  });
  const students = `nl:course:${courseId}:students`;
  const again = `nl:course:${courseId}:again`;
  const field = emailKey(BUYER);
  /** The row the course page wrote for the purchase refunded in full, four months before. */
  const openedBefore = async () => {
    await redis.pipeline([["DEL", again], ["HSET", students, field, JSON.stringify({ e: BUYER, s: before, l: before })]]);
  };
  const noted = () => redis.run(["SISMEMBER", again, field]);

  part("Bought again, its confirmation email refused");
  await openedBefore();
  emailsWork = false;
  const refused = "cs_test_confirmnote0refused1";
  is("the confirmation is not sent, so it is tried again", await confirmPurchase(store, refused, checkout(refused) as never), "failed");
  is("the purchase is still noted for the drip job", noted(), 1);
  emailsWork = true;
  is("tried again: sent", await confirmPurchase(store, refused, checkout(refused) as never), "sent");
  is("noted once", redis.run(["SMEMBERS", again]), [field]);

  part("Bought again, the note's write lost once");
  await openedBefore();
  const dropped = "cs_test_confirmnote0dropped1";
  lost = { match: (c) => c[0] === "SADD" && c[1] === again, reply: "QUEUED" };
  const outcome = await confirmPurchase(store, dropped, checkout(dropped) as never);
  is("the confirmation is not kept as sent while the note is unknown", redis.run(["GET", confirmationKey(dropped)]) === "sent" && noted() === 0, false);
  if (outcome !== "sent") is("tried again: sent", await confirmPurchase(store, dropped, checkout(dropped) as never), "sent");
  is("and the purchase is noted", noted(), 1);

  part("Controls");
  await redis.pipeline([["DEL", again]]);
  await redis.pipeline([["HSET", students, field, JSON.stringify({ e: BUYER, s: now, l: now })]]);
  const same = "cs_test_confirmnote0samedy1";
  is("a row already from this purchase: sent", await confirmPurchase(store, same, checkout(same) as never), "sent");
  is("and nothing to note", noted(), 0);
  await redis.pipeline([["HDEL", students, field]]);
  const fresh = "cs_test_confirmnote0fresh01";
  is("a student never seen: sent", await confirmPurchase(store, fresh, checkout(fresh) as never), "sent");
  is("and nothing to note", noted(), 0);
  is("a confirmation already sent: not sent again", await confirmPurchase(store, fresh, checkout(fresh) as never), "already");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
