/**
 * A member's failed-payment email whose send came back unknown is not sent
 * again a day or two later (lib/payment-recovery.ts, remindFailed).
 *
 * Amazon SES answering a 5xx, or its reply lost after the request, may follow
 * acceptance. sendEmail answers false for it as for a refusal, and the job let
 * its once-only mark go on any false. The email's idempotency key is kept only
 * a day (viaAmazon's once mark, EX 86400; Resend's key, 24 hours), while the
 * job runs daily (app/api/cron/plans, 09:00) and an unpaid invoice stays open
 * for weeks: every run inside that day finds the once mark, answers unknown
 * again and lets the job's mark go again, and the first run after it runs out
 * sends the same "your payment didn't go through" email a second time, from
 * the store's email room. A known refusal still lets the mark go, so the email
 * is tried again on the next run rather than never.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts), the synthetic SES
 * (tests/ses-mail-fixture.ts) and a Stripe stand-in; nothing leaves. The
 * in-memory Redis reads the same moved clock, so the once mark runs out after
 * 86,400 seconds as it would in Redis.
 */
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400_000;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const state = { pastDue: [] as Record<string, unknown>[] };
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mail = installSesMailFixture({
  fallback: async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    if (path === "/subscriptions" && method === "GET") {
      return answer({ object: "list", data: url.searchParams.get("status") === "past_due" ? state.pastDue : [], has_more: false });
    }
    if (/^\/subscriptions\/sub_\w+$/.test(path) && method === "POST") return answer({ id: path.split("/").pop() });
    if (path === "/invoices" && method === "GET") return answer({ object: "list", data: [], has_more: false });
    return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
  },
});

const ACCOUNT = "acct_1TestUnknown0001";
const run = () => recoverFailedPayments(Date.now() + 20_000);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recovery_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
  redis.clear();
  mail.configure();

  const OWNER = "unknown-owner@example.com";
  const made = await claimHandle(OWNER, "unknown-harbor", "Unknown Harbor", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_UnkOwner0001", subscriptionId: "sub_UnkOwner0001", active: true, period: paidPeriod(Date.now(), { behind: 1, ahead: 60 }) });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const meta = { store: "unknown-harbor", product: club.product.id };
  const failing = (n: string) => ({
    id: `sub_Unknown${n}00001`, status: "past_due", metadata: meta,
    customer: { id: `cus_Unknown${n}0001`, email: `member-${n}@example.com` },
    latest_invoice: { id: `in_Unknown${n}00001`, status: "open", amount_due: 2900, currency: "usd", hosted_invoice_url: `https://invoice.stripe.com/i/${n}`, next_payment_attempt: 0 },
  });
  const asked = (n: string) => mail.sesAttempts.filter((m) => m.to.includes(`member-${n}@example.com`)).length;

  part("SES's reply lost after the request: the member is not written to again once the key's day is over");
  state.pastDue = [failing("aa")];
  mail.setSesOutcome(["lost"]);
  await run();
  is("SES was asked once", asked("aa"), 1);
  shift += DAY / 2;
  await run();
  is("half a day on, inside the key's day, nothing more", asked("aa"), 1);
  // The next daily run, after the once mark (EX 86400) has run out.
  shift += DAY;
  await run();
  is("a day on, the same email is not sent a second time", asked("aa"), 1);
  shift += DAY;
  await run();
  is("nor the day after", asked("aa"), 1);

  part("A known refusal is still tried again on the next run, once");
  state.pastDue = [failing("bb")];
  mail.setSesOutcome(["refused"]);
  await run();
  is("SES refused it once", asked("bb"), 1);
  shift += 2 * DAY;
  await run();
  is("a later run asks again, and it goes", asked("bb"), 2);
  shift += 2 * DAY;
  await run();
  is("and never a third time", asked("bb"), 2);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
