/** NEW S probe, derived from author fixture; NOT recovered original source. */
import { sendFailedPlanNotices } from "@/lib/billing-reminders";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_failed_plan_only";
process.env.RESEND_API_KEY = "re_test_failed_plan_only";

const NOW = 1_791_700_000;
const DAY = 86_400;
const emails: string[] = [];
let rejected = "";
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
    if (rejected && String(init?.body).includes(rejected)) return answer({message:"synthetic permanent refusal"},422);
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push(Array.isArray(body.to) ? body.to[0] : body.to);
    return answer({ id: `re_${emails.length}` });
  }
  return answer({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

const PRICE = { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } };

/** A renewal that failed, with its invoice open to pay. */
function failing(id: string): Record<string, unknown> {
  return {
    id, status: "past_due", created: NOW - 90 * DAY, trial_end: NOW - 76 * DAY,
    customer: { email: `${id}@example.com` },
    items: { data: [{ current_period_start: NOW - 2 * DAY, current_period_end: NOW + 28 * DAY, price: PRICE }] },
    latest_invoice: { id: `in_${id.slice(4)}inv`, status: "open", amount_due: 2900, hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, next_payment_attempt: NOW + 3 * DAY },
  };
}

const sentTo = (address: string) => emails.filter((to) => to === address).length;

async function main(): Promise<void> {
  redis.clear(); rejected = "sub_SReject1108@example.com";
  lists.past_due = [failing("sub_SFirst1108"), failing("sub_SReject1108"), failing("sub_SLast01108")];
  await sendFailedPlanNotices();
  is("healthy neighbors notified once", [sentTo("sub_SFirst1108@example.com"), sentTo("sub_SLast01108@example.com")], [1,1]);
  lists.past_due.unshift(failing("sub_SNewest1108"));
  for (let i=0; i<3; i++) await sendFailedPlanNotices();
  console.log("NEW_S_CURSOR", JSON.stringify(await redis.pipeline([["GET", "nl:remind:after:past_due"]])));
  is("new creator notified despite permanent refusal", sentTo("sub_SNewest1108@example.com"), 1);
  rejected=""; await sendFailedPlanNotices(); await sendFailedPlanNotices();
  is("refused creator notified once after recovery", sentTo("sub_SReject1108@example.com"), 1);
  is("new creator eventually notified once", sentTo("sub_SNewest1108@example.com"), 1);
  is("healthy notices never duplicated", [sentTo("sub_SFirst1108@example.com"), sentTo("sub_SLast01108@example.com")], [1,1]);
  done();
}
void main();
