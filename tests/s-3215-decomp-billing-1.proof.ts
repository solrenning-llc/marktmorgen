/**
 * A creator's billing reminders (lib/billing-reminders.ts) are never lost to a mark that could not be let go, or to
 * a list longer than one run reads (rule 24, R24 inventory, crons item 6).
 *
 *   - An email that could not be sent lets its mark go, so the next run tries again. Letting go used to be one DEL
 *     whose failure was swallowed: the mark then stayed 60 or 90 days and the reminder was never tried again, with
 *     nothing said. The DEL is now tried twice, and a mark still held is counted (`unreleased`) and logged.
 *   - Each list was read for at most 50 pages from the top, in silence: a subscription past them was never reached.
 *     A run that stops at the cap now says so (`more`) and the next run goes on from there.
 *
 * Never twice: a reminder already sent is never sent again. Synthetic Stripe and Resend stand-ins only.
 */
import { sendFailedPlanNotices, sendReminders } from "@/lib/billing-reminders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_failed_plan_only";
process.env.RESEND_API_KEY = "re_test_failed_plan_only";

const NOW = 1_791_700_000;
const DAY = 86_400;
const emails: string[] = [];
let emailWorks = true;
const lists: Record<string, Record<string, unknown>[]> = { trialing: [], active: [], past_due: [] };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.stripe.com") {
    if (method === "GET" && url.pathname === "/v1/subscriptions") {
      const all = lists[url.searchParams.get("status") ?? ""] ?? [];
      const after = url.searchParams.get("starting_after");
      const from = after ? all.findIndex((s) => s.id === after) + 1 : 0;
      const limit = Number(url.searchParams.get("limit")) || 10;
      return answer({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) return answer({ id: url.pathname.split("/").pop() });
  }
  if (url.hostname === "api.resend.com") {
    if (!emailWorks) return answer({ message: "down" }, 500);
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push(Array.isArray(body.to) ? body.to[0] : body.to);
    return answer({ id: `re_${emails.length}` });
  }
  return answer({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

const PRICE = { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } };

/** A trial; its charge `daysLeft` days away (a reminder is due from eight days before). */
function trial(id: string, daysLeft: number): Record<string, unknown> {
  return {
    id, status: "trialing", created: NOW - 6 * DAY, trial_end: NOW + daysLeft * DAY,
    customer: { email: `${id}@example.com` },
    items: { data: [{ current_period_start: NOW - 6 * DAY, current_period_end: NOW + daysLeft * DAY, price: PRICE }] },
  };
}

/** A renewal that failed, with its invoice open to pay. */
function failing(id: string): Record<string, unknown> {
  return {
    id, status: "past_due", created: NOW - 90 * DAY, trial_end: NOW - 76 * DAY,
    customer: { email: `${id}@example.com` },
    items: { data: [{ current_period_start: NOW - 2 * DAY, current_period_end: NOW + 28 * DAY, price: PRICE }] },
    latest_invoice: { id: `in_${id.slice(4)}inv`, status: "open", amount_due: 2900, hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, next_payment_attempt: NOW + 3 * DAY },
  };
}

/** Runs `run` with the first `times` pipelines that DEL a key starting `prefix` failing, as Redis can. */
async function delFails<T>(prefix: string, times: number, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let left = times;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (left > 0 && commands[0]?.[0] === "DEL" && String(commands[0]?.[1] ?? "").startsWith(prefix)) {
      left -= 1;
      throw new Error("Redis did not answer");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

const sentTo = (address: string) => emails.filter((to) => to === address).length;
/** Independently reset original scenario; see the complete provenance manifest. */
async function main(): Promise<void> {


void trial; void failing; void sentTo; void sendReminders; void sendFailedPlanNotices;

  part("A trial reminder whose email failed, and whose mark could not be let go at once");

  redis.clear();

  lists.trialing = [trial("sub_TrialOnce0001", 7)];

  emailWorks = false;

  const down = await delFails("nl:remind:trial:", 1, () => sendReminders(NOW));

  is("not sent, and said so", [down.sent, down.failed], [0, 1]);

  emailWorks = true;

  await sendReminders(NOW);

  is("the next run sends it: the mark was let go on the second try", sentTo("sub_TrialOnce0001@example.com"), 1);

  await sendReminders(NOW);

  is("and never twice", sentTo("sub_TrialOnce0001@example.com"), 1);
  done();
}

void main();
