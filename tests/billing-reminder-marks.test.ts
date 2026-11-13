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

async function main(): Promise<void> {
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

  part("A mark that cannot be let go at all is said, never swallowed");
  redis.clear();
  lists.trialing = [trial("sub_TrialStuck001", 7)];
  emailWorks = false;
  const stuck = await delFails("nl:remind:trial:", 10, () => sendReminders(NOW));
  emailWorks = true;
  is("counted as a reminder that will not be tried again by itself", (stuck as { unreleased?: unknown }).unreleased, 1);
  redis.clear();
  lists.trialing = [trial("sub_TrialFine0001", 7)];
  const fine = await sendReminders(NOW);
  is("a run where every mark was let go or kept counts none (control)", [fine.sent, (fine as { unreleased?: unknown }).unreleased], [1, 0]);

  part("A creator's failed payment whose email failed, and whose mark could not be let go at once");
  redis.clear();
  lists.trialing = [];
  lists.past_due = [failing("sub_FailedOnce001")];
  emailWorks = false;
  const failedDown = await delFails("nl:remind:failed:", 1, () => sendFailedPlanNotices());
  is("not sent, and said so", [failedDown.sent, failedDown.failed], [0, 1]);
  emailWorks = true;
  await sendFailedPlanNotices();
  is("the next run sends it", sentTo("sub_FailedOnce001@example.com"), 1);
  await sendFailedPlanNotices();
  is("and never twice", sentTo("sub_FailedOnce001@example.com"), 1);
  redis.clear();
  lists.past_due = [failing("sub_FailedStuck01")];
  emailWorks = false;
  const failedStuck = await delFails("nl:remind:failed:", 10, () => sendFailedPlanNotices());
  emailWorks = true;
  is("a mark that cannot be let go is counted", (failedStuck as { unreleased?: unknown }).unreleased, 1);
  lists.past_due = [];

  part("A claim answered in another shape is unknown: no email on a guess (Claude 1 and Claude 6 on #3215)");
  {
    const real = redis.pipeline.bind(redis);
    let left = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (left > 0 && commands[0]?.[0] === "SET" && /^nl:remind:(trial|failed):/.test(String(commands[0]?.[1] ?? ""))) {
        left -= 1;
        return ["QUEUED"];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    redis.clear();
    lists.past_due = [];
    lists.trialing = [trial("sub_TrialOdd00001", 7)];
    left = 1;
    await sendReminders(NOW);
    is("a trial reminder whose claim answered QUEUED is not sent", sentTo("sub_TrialOdd00001@example.com"), 0);
    await sendReminders(NOW);
    is("the next run claims it and sends it once", sentTo("sub_TrialOdd00001@example.com"), 1);
    lists.trialing = [];
    lists.past_due = [failing("sub_FailedOdd0001")];
    left = 1;
    await sendFailedPlanNotices();
    is("a failed-payment notice whose claim answered QUEUED is not sent", sentTo("sub_FailedOdd0001@example.com"), 0);
    await sendFailedPlanNotices();
    is("the next run sends it once", sentTo("sub_FailedOdd0001@example.com"), 1);
    lists.past_due = [];
    redis.pipeline = real;
  }

  part("More trials than one run reads");
  redis.clear();
  // 5,050 trials, one due: the 5,021st, past the fifty pages of a hundred one run reads.
  lists.trialing = Array.from({ length: 5_050 }, (_, i) => trial(`sub_TrialMany${String(i).padStart(4, "0")}`, i === 5_020 ? 7 : 20));
  const first = await sendReminders(NOW);
  is("the first run stops at the cap and says there is more", [first.sent, first.seen, (first as { more?: unknown }).more], [0, 5_000, true]);
  const second = await sendReminders(NOW);
  is("the next run goes on from there, and reaches it", [sentTo("sub_TrialMany5020@example.com"), second.seen, (second as { more?: unknown }).more], [1, 50, false]);
  const third = await sendReminders(NOW);
  is("then starts from the top again, and never sends twice", [sentTo("sub_TrialMany5020@example.com"), third.seen], [1, 5_000]);
  lists.trialing = [];

  done();
}

void main();
