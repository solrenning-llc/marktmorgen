/**
 * lib/billing-reminders.ts: a run whose email did not go lets go only of its own once-only mark (lib/claim-mark.ts).
 * A slow run whose mark ran out, and was taken by another run of the same reminder, never deletes the other run's
 * mark when it fails, so the same email is never sent twice; a run whose own mark is still there lets it go, so the
 * next run tries again, as before.
 */
import { sendFailedPlanNotices, sendReminders } from "@/lib/billing-reminders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_billing_once_owner_only";
// A synthetic credential the Resend fallback fixture already knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_failed_plan_only";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const emails: string[] = [];
let failSending = false;
/** Runs once, while the next email is being sent (a slow run's send). */
let duringSend: (() => void) | null = null;
let listed: Record<string, Record<string, unknown>[]> = {};

function plan(id: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status,
    created: NOW - 90 * DAY,
    customer: { email: `${id}@example.com` },
    items: {
      data: [
        {
          current_period_start: NOW - 2 * DAY,
          current_period_end: NOW + 28 * DAY,
          price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } },
        },
      ],
    },
    ...over,
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    if (method === "GET" && url.pathname === "/v1/subscriptions") {
      return new Response(JSON.stringify({ data: listed[url.searchParams.get("status") ?? ""] ?? [], has_more: false }), { status: 200 });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) {
      return new Response(JSON.stringify({ id: url.pathname.split("/").pop() }), { status: 200 });
    }
  }
  if (url.hostname === "api.resend.com") {
    const during = duringSend;
    duringSend = null;
    during?.();
    // A known refusal (not an uncertain 5xx): nothing was accepted, so the reminder is tried again.
    if (failSending) return new Response(JSON.stringify({ message: "synthetic known refusal" }), { status: 422 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push(Array.isArray(body.to) ? body.to[0] : body.to);
    return new Response(JSON.stringify({ id: `re_${emails.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** While the slow run's email is being sent, its mark runs out and another run of the same reminder takes it. */
const takenMeanwhile = (key: string) => () => {
  redis.run(["DEL", key]);
  redis.run(["SET", key, "another-run", "EX", 60 * DAY]);
};

async function main(): Promise<void> {
  const logged = console.error;
  console.error = () => {};
  try {
    part("A failed plan's notice: a slow run that fails lets go only of its own mark");
    redis.clear();
    listed = {
      past_due: [plan("sub_slowfailed01", "past_due", {
        trial_end: NOW - 76 * DAY,
        latest_invoice: { id: "in_slowfailed01", status: "open", amount_due: 2900, hosted_invoice_url: "https://invoice.stripe.com/i/x", next_payment_attempt: NOW + 3 * DAY },
      })],
    };
    const failedKey = "nl:remind:failed:in_slowfailed01";
    duringSend = takenMeanwhile(failedKey);
    failSending = true;
    is("the slow run's email did not go", (await sendFailedPlanNotices()).failed, 1);
    failSending = false;
    is("the other run's mark is left in place", redis.run(["GET", failedKey]), "another-run");
    is("so the next run does not send the same notice again", [(await sendFailedPlanNotices()).sent, emails.length], [0, 0]);

    part("A failed plan's notice: a run's own mark still goes, so the next run tries again");
    redis.run(["DEL", failedKey]);
    failSending = true;
    await sendFailedPlanNotices();
    failSending = false;
    is("its own mark is let go", redis.run(["GET", failedKey]), null);
    is("and the next run sends it", [(await sendFailedPlanNotices()).sent, emails.length], [1, 1]);

    part("A trial reminder: a slow run that fails lets go only of its own mark");
    redis.clear();
    emails.length = 0;
    const trialEnd = NOW + 5 * DAY;
    listed = { trialing: [plan("sub_slowtrial001", "trialing", { trial_end: trialEnd })] };
    const trialKey = `nl:remind:trial:sub_slowtrial001:${trialEnd}`;
    duringSend = takenMeanwhile(trialKey);
    failSending = true;
    is("the slow run's email did not go", (await sendReminders(NOW)).failed, 1);
    failSending = false;
    is("the other run's mark is left in place", redis.run(["GET", trialKey]), "another-run");
    is("so the next run does not send the same reminder again", [(await sendReminders(NOW)).sent, emails.length], [0, 0]);

    part("A trial reminder: a run's own mark still goes, so the next run tries again");
    redis.run(["DEL", trialKey]);
    failSending = true;
    await sendReminders(NOW);
    failSending = false;
    is("its own mark is let go", redis.run(["GET", trialKey]), null);
    is("and the next run sends it", [(await sendReminders(NOW)).sent, emails.length], [1, 1]);
  } finally {
    console.error = logged;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
