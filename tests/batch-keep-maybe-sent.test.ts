/**
 * An email batch the provider may have taken stays counted (owner rule MR: a ceiling before every spend; unknown
 * is never room). The senders of many emails at a time reserve the store's monthly emails before sending and gave
 * them all back on any answer but "sent" (lib/product-updates.ts, lib/community-mail.ts, lib/review-requests.ts,
 * the studio's test email, lib/imports.ts, lib/waitlist.ts's day). But "retry" also means a reply lost after the
 * provider took the batch (a timeout, a 5xx), and "refused" can follow Amazon SES taking part of it: the emails
 * went, were paid for, and their count went back, so the store could send past its monthly emails. The broadcast
 * sender (lib/mail.ts sendTo) already kept them; its siblings now do too, from the sender's own receipt
 * (lib/email.ts sendBatchNoting): given back only when no provider can have taken any of the batch.
 *
 * Resend is stood in for over fetch; Redis is the repository's in-memory stand-in; every address is synthetic.
 */
import { advanceUpdate, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { usedThisMonth } from "@/lib/mail";
import * as email from "@/lib/email";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
let resendAnswers = 200;
let taken = 0;
let sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body)) as unknown[];
      // A 5xx after taking the batch: the provider has the emails, the answer says nothing of them.
      if (resendAnswers >= 500) taken += batch.length;
      if (resendAnswers !== 200) return Response.json({ message: "synthetic" }, { status: resendAnswers });
      taken += batch.length;
      return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
    }
    return Response.json({ id: "email_1" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  if (path === "/checkout/sessions") return list(sessions);
  return list([]);
}) as typeof fetch;

const paid = (id: string, email: string, product: string) => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000) - 86_400,
  amount_total: 2700, currency: "usd", customer_details: { email }, metadata: { store: "harbor", product },
});
type Noting = (messages: email.BatchMessage[], batchKey: string, meter: email.EmailMeter, receipt: { maybeSent: boolean }) => Promise<"sent" | "retry" | "refused">;
/** The sender with its receipt; before it existed, the plain sender, whose receipt says nothing. */
const sendBatchNoting: Noting = (email as unknown as { sendBatchNoting?: Noting }).sendBatchNoting ?? ((messages, key, meter) => email.sendBatch(messages, key, meter));
const letter = (to: string) => ({ from: "Harbor <harbor@example.com>", to, subject: "Hello", text: "Hello", html: "<p>Hello</p>" });

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  const quiet = console.error;
  console.error = () => {};

  part("The sender's receipt: whether a provider may have taken any of the batch");
  const fresh = () => ({ maybeSent: false });
  let receipt = fresh();
  resendAnswers = 200;
  is("control: a batch taken is sent, and may have been", [await sendBatchNoting([letter("a@example.com")], "k:ok", { by: "company" }, receipt), receipt.maybeSent], ["sent", true]);
  receipt = fresh();
  resendAnswers = 500;
  is("a reply lost after the provider took it is retried, and may have been sent", [await sendBatchNoting([letter("b@example.com")], "k:lost", { by: "company" }, receipt), receipt.maybeSent], ["retry", true]);
  receipt = fresh();
  resendAnswers = 422;
  is("control: a batch the provider refused outright was not sent", [await sendBatchNoting([letter("c@example.com")], "k:refused", { by: "company" }, receipt), receipt.maybeSent], ["refused", false]);

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Jenny at Harbor", address: "1 Main St, Portland, OR 97201" });
  const load = async () => (await storeForEmail(OWNER))!;
  const lost = await addProduct(OWNER, "Weekly Meal Planner", "", "27", null);
  const refused = await addProduct(OWNER, "Pantry Checklist", "", "5", null);
  if (!lost.ok || !refused.ok) throw new Error("no product");
  await setProductLink(OWNER, lost.product.id, "https://example.com/planner");
  await setProductLink(OWNER, refused.product.id, "https://example.com/pantry");
  sessions = [paid("cs_1", "ana@example.com", lost.product.id), paid("cs_2", "ben@example.com", refused.product.id)];
  const month = async () => usedThisMonth((await load()).listId, windowId(await load()));

  part("A product update whose batch the provider took, with its answer lost, stays counted");
  const first = await startUpdate(await load(), (await readListing(await load(), lost.product.id))!, "Ten new recipes.");
  if (!first.ok) throw new Error(`not started: ${first.reason}`);
  const before = await month();
  const takenBefore = taken;
  resendAnswers = 500;
  await advanceUpdate(first.job.id, storeForHandle, Date.now() + 20_000);
  is("the provider took the email", taken - takenBefore, 1);
  is("and it stays counted in the store's month", (await month()) - before, 1);

  part("Control: a product update the provider refused outright is given back");
  const second = await startUpdate(await load(), (await readListing(await load(), refused.product.id))!, "A new page.");
  if (!second.ok) throw new Error(`not started: ${second.reason}`);
  const again = await month();
  resendAnswers = 422;
  const job = await advanceUpdate(second.job.id, storeForHandle, Date.now() + 20_000);
  is("nothing was taken, the job stops", job?.status, "failed");
  is("and what was reserved for it goes back", (await month()) - again, 0);

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
