/**
 * A member pressing "Resume now" twice during a pause (lib/membership-pause.ts,
 * resumeMembership). Resuming inside a pause starts a new period that day with
 * a payment (`billing_cycle_anchor=now`): each such request Stripe carries out
 * charges the member again. Two presses that both read the membership as
 * paused, before either change lands, must not both send it; the second waits
 * for the first and then reads the membership as it is, no longer paused.
 * Synthetic Stripe and Redis only.
 */
import { addMonths } from "@/lib/membership-pause-rules";
import { resumeMembership } from "@/lib/membership-pause";
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, setPauseMonths, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 9, 11, 12) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 9, 31, 9) / 1000);

let sub: Record<string, unknown> = {
  id: "sub_Member0000001",
  status: "active",
  customer: "cus_Member000001",
  pause_collection: { behavior: "void", resumes_at: addMonths(PERIOD_END, 2) },
  metadata: { store: "club", product: "prod000001", pause_from: String(PERIOD_END), paused_at: String(NOW) },
  items: { data: [{ current_period_end: PERIOD_END, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
};
const charges: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/customers" && method === "GET") return json({ data: [{ id: "cus_Member000001" }], has_more: false });
  if (path === "/customers/cus_Member000001") return json({ id: "cus_Member000001", email: "member@example.com" });
  if (path === "/subscriptions" && method === "GET") return json({ data: [sub], has_more: false });
  if (path === "/subscriptions/sub_Member0000001" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    // The network and Stripe take a moment: a second press arrives meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A new period from now with no proration: Stripe invoices it and takes the payment, every time.
    if (body.get("billing_cycle_anchor") === "now") charges.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    const metadata = { ...(sub.metadata as Record<string, string>) };
    if (body.has("metadata[pause_from]")) metadata.pause_from = body.get("metadata[pause_from]") ?? "";
    sub = { ...sub, metadata, pause_collection: body.has("pause_collection") ? null : sub.pause_collection };
    return json(sub);
  }
  return json({ data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_resume_only_a_stand_in";
  const OWNER = "club@example.com";
  await claimHandle(OWNER, "club", "Supper Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestClub000001", true);
  await setPauseMonths(OWNER, 2);
  const store = (await storeForEmail(OWNER))!;
  // The member's emailed link, as requestManageLink keeps it (lib/membership-manage.ts, tokenKey): this test is
  // about the presses, not the email that carries the link.
  const token = "ab".repeat(32);
  const linkKey = `nl:manage:link:${createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", linkKey, JSON.stringify({ a: store.stripeAccountId, c: "cus_Member000001", h: store.handle }), "EX", 3600]]);

  part("Two presses of Resume now inside the pause");
  const when = PERIOD_END + DAY;
  const [first, second] = await Promise.all([
    resumeMembership(store, token, "sub_Member0000001", when),
    resumeMembership(store, token, "sub_Member0000001", when),
  ]);
  is("the member is charged for the new period once, never twice", charges.length, 1);
  is("one press resumes it; the other finds it no longer paused", [first.ok, second.ok].filter(Boolean).length, 1);
  is("and the membership is running again", sub.pause_collection, null);

  part("A press after it resumed");
  const again = await resumeMembership(store, token, "sub_Member0000001", when);
  is("finds nothing to resume and charges nothing", [again.ok, charges.length], [false, 1]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
