/**
 * The "your plan starts again soon" notice of a break (lib/plan-pause.ts,
 * runBreaks) under a sender whose answer is not known (rule 30, a sibling of
 * 283 [HG2] unit 1's sendEmailOutcome).
 *
 * The notice has no idempotency key of its own, so a send that may have gone
 * (a server error, or a network error after the request) and is then tried
 * again by the next daily run writes to the creator twice. It is now marked
 * told on an uncertain answer, so the next run does not ask again; only a
 * certain refusal (a 4xx) leaves it for the next run. Stripe and the sender
 * are played by a stand-in for `fetch`; no real email is sent. Checked:
 *
 *   - a 500 from the sender: asked once over two runs, the record marked told;
 *   - a thrown request (network error): the same;
 *   - a 422 (a certain refusal): not marked, the next run asks again and,
 *     answered yes, marks it (control: unchanged behavior);
 *   - a plain yes: asked once, marked (control).
 */
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { pausePlan, pauseOf, runBreaks } from "@/lib/plan-pause";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_uncertain_pause_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const DAY = 86_400;
const NOW = 1_791_700_000;
/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();
const subs: Record<string, Record<string, unknown>> = {};

function subscription(id: string): Record<string, unknown> {
  return {
    id,
    status: "active",
    customer: "cus_TestPause0001",
    default_payment_method: "pm_TestCard00001",
    cancel_at_period_end: false,
    start_date: NOW - 100 * DAY,
    trial_end: NOW - 86 * DAY,
    items: { data: [{ current_period_end: NOW + 10 * DAY, price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } } }] },
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    const m = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/);
    if (m && subs[m[1]]) {
      if (method === "POST") {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.has("cancel_at_period_end")) subs[m[1]].cancel_at_period_end = body.get("cancel_at_period_end") === "true";
      }
      return new Response(JSON.stringify(subs[m[1]]), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `no route ${method} ${url.pathname}` } }), { status: 404 });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to: string | string[] };
    const to = [body.to].flat()[0] ?? "";
    asked.push(to);
    const special = senderAnswers.get(to);
    if (special) return special();
    return new Response(JSON.stringify({ id: `re_${asked.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const askedOf = (email: string) => asked.filter((to) => to === email).length;
const answerOf = (status: number) => new Response(JSON.stringify({ message: "stand-in" }), { status });

/** A store on a one-month break whose paid period has ended; its `until`. */
async function onBreak(email: string, handle: string, sub: string): Promise<number> {
  subs[sub] = subscription(sub);
  await claimHandle(email, handle, "A store", "");
  await setSubscription(email, { customerId: "cus_TestPause0001", subscriptionId: sub, active: true, tier: "creator", cycle: "month" });
  const set = await pausePlan((await storeForEmail(email))!, 1, NOW);
  if (set.kind !== "paused") throw new Error(`no break for ${email}: ${JSON.stringify(set)}`);
  await setSubscription(email, { active: false });
  return set.record.until;
}

async function toldOf(email: string): Promise<number | undefined> {
  return (await pauseOf((await storeForEmail(email))!))?.told;
}

async function main(): Promise<void> {
  const una = "una@example.com";
  const tom = "tom@example.com";
  const rex = "rex@example.com";
  const ola = "ola@example.com";
  const until = await onBreak(una, "unastore", "sub_Una000000001");
  for (const [email, handle, sub] of [[tom, "tomstore", "sub_Tom000000001"], [rex, "rexstore", "sub_Rex000000001"], [ola, "olastore", "sub_Ola000000001"]]) {
    if ((await onBreak(email, handle, sub)) !== until) throw new Error("breaks end on different days");
  }
  senderAnswers.set(una, () => answerOf(500));
  senderAnswers.set(tom, () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  senderAnswers.set(rex, () => answerOf(422));

  part("A week before the end, the first run");
  await runBreaks(until - 6 * DAY);
  is("each creator's sender was asked once", [askedOf(una), askedOf(tom), askedOf(rex), askedOf(ola)], [1, 1, 1, 1]);
  is("a 500 is marked told: it may have gone", Boolean(await toldOf(una)), true);
  is("a thrown request is marked told: it may have gone", Boolean(await toldOf(tom)), true);
  is("a certain refusal is not marked", await toldOf(rex), 0);
  is("a plain yes is marked (control)", Boolean(await toldOf(ola)), true);

  part("The next day's run");
  senderAnswers.delete(una);
  senderAnswers.delete(tom);
  senderAnswers.delete(rex);
  await runBreaks(until - 5 * DAY);
  is("the uncertain notices are not sent a second time", [askedOf(una), askedOf(tom)], [1, 1]);
  is("the refused one is asked again, and now marked", [askedOf(rex), Boolean(await toldOf(rex))], [2, true]);
  is("the one that went is not asked again (control)", askedOf(ola), 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
