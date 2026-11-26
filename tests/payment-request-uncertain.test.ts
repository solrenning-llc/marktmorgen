/**
 * A payment request's email (lib/payment-requests.ts, sendRequestEmail) whose send has an answer that is not known
 * (webhooks/cron audit, Claude 1, 12/11/2026): a server error or a lost answer after the email was handed to the
 * sender, so it may have gone. It was read as "not sent", written down as failed, and the daily job tried it again a
 * day later (RETRY_MS) under the same idempotency key, which neither sender still honours by then (Resend keeps a
 * key a day; the SES mark lasts 86,400 seconds): the buyer could be asked for the same payment twice. Now an
 * unknown answer counts as sent, as everywhere else mail that may have left does (rule 30): written down as sent,
 * so the next reminder waits its own day; a certain refusal is still tried again a day later.
 * Synthetic only: the Redis stub and the SES mail fixture.
 */
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { REMIND_EVERY_DAYS, readDraft } from "@/lib/payment-request-rules";
import { createRequest, readRequest } from "@/lib/payment-request-store";
import { sendDueReminders, sendRequestEmail } from "@/lib/payment-requests";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

/** Stripe is not reached by these steps; the sender is Amazon SES, as in production (Resend stays closed). */
const fixture = installSesMailFixture({ fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 }) });
fixture.configure();
/** Every email handed to SES, answered or not: each may have reached the buyer. */
const handed = (to: string) => fixture.sesAttempts.filter((m) => m.to.includes(to)).length;

/**
 * The next daily run is a day later (RETRY_MS, 86,400,000 ms), and the SES once-only mark of a key lasts 86,400 s
 * (lib/email.ts, viaAmazon): by then it has run out. The in-memory Redis keeps real time, so the day is played by
 * letting those marks go, as their expiry does.
 */
const aDayPasses = (...keys: string[]) => {
  for (const key of keys) redis.run(["DEL", `nl:ses:once:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`]);
};

const DAY = 86_400_000;
const LINE = { text: "Coaching, October (4 sessions)", quantity: 1, amount: "480" };

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Dana's Studio Coaching", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1Req${handle.slice(0, 8).padEnd(8, "x")}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "scale", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_payment_requests_only_a_stand_in";
  delete process.env.RESEND_API_KEY;
  const now = Date.now();
  const store = await paidStore("uncertain-requests@example.com", "uncertainreq");
  const draft = readDraft({ email: "buyer@example.com", name: "Dana", lines: [LINE], note: "", dueDate: "", autoReminders: 2, consent: true }, "usd", now);
  if (!draft.ok) throw new Error("no draft");
  const made = await createRequest(store, draft.draft, now);
  if (!made.ok) throw new Error("no request");
  const id = made.request.id;
  await sendRequestEmail(store, made.request, now);
  const toBuyer = () => handed("buyer@example.com");
  is("set-up: the request went", toBuyer(), 1);

  part("The first reminder's send has an answer that is not known");
  fixture.setSesOutcome("server-error");
  const firstDay = now + REMIND_EVERY_DAYS * DAY + 1;
  await sendDueReminders(Date.now() + 10_000, firstDay);
  is("it was handed to the sender once", toBuyer(), 2);
  is("and is written down as sent, not as failed", [(await readRequest(id))!.sent.length, (await readRequest(id))!.failed], [2, ""]);

  part("A day on: the same reminder is never handed over again");
  fixture.setSesOutcome("ok");
  aDayPasses(`nimbus-payreq:${id}:1`);
  await sendDueReminders(Date.now() + 10_000, firstDay + DAY + 1);
  is("nothing more a day later", toBuyer(), 2);
  await sendDueReminders(Date.now() + 10_000, firstDay + REMIND_EVERY_DAYS * DAY + 1);
  is("the second reminder goes on its own day", toBuyer(), 3);

  part("Control: a certain refusal is tried again a day later");
  const other = readDraft({ email: "refused@example.com", name: "Lee", lines: [LINE], note: "", dueDate: "", autoReminders: 2, consent: true }, "usd", now);
  if (!other.ok) throw new Error("no draft");
  const second = await createRequest(store, other.draft, now);
  if (!second.ok) throw new Error("no request");
  await sendRequestEmail(store, second.request, now);
  const toRefused = () => handed("refused@example.com");
  fixture.setSesOutcome("refused");
  await sendDueReminders(Date.now() + 10_000, firstDay);
  is("refused: not written down as sent", [toRefused(), (await readRequest(second.request.id))!.sent.length], [2, 1]);
  fixture.setSesOutcome("ok");
  aDayPasses(`nimbus-payreq:${second.request.id}:1`);
  await sendDueReminders(Date.now() + 10_000, firstDay + DAY + 1);
  is("and sent the day after", [toRefused(), (await readRequest(second.request.id))!.sent.length], [3, 2]);
  done();
}

void main();
