/**
 * The commands of a tip checkout, held inside the envelope of one public request (Claude 1 coord 16c2, #5010 row 84).
 *
 * A tip checkout is the "tip" public request (tests/plan-cost-registry.ts, `tip: PUBLIC`). Its Redis work is measured
 * here on the real route, POST /api/store/tip, and must stay within the dearest public request of the model, a later
 * page (tests/traffic-cost.ts, COMMANDS.laterPage + COMMANDS.laterCount, 18). Every command is billed as Upstash bills
 * it, by the registry's rule (tests/plan-cost-registry.ts, rule 964c): one a plain command, and an EVAL as one plus
 * the calls its script makes. Both the buyer's first checkout in the window, the worst case (its counters also get
 * their expiry), and a later one are measured. Measured on 23 November 2026: 11 and 10, the tip mark written by
 * setWhileStoreLive (Codex L-20261119-1636). (Counted as max(1, calls) before the coordinator's triple audit
 * 7091737647, which gave 10 and 9.)
 *
 * Synthetic store, Redis stand-in and Stripe stub only; nothing real is called.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, setTips, storeForEmail } from "@/lib/store";
import { POST } from "@/app/api/store/tip/route";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { COMMANDS } from "./traffic-cost";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_tip_envelope_only";
const OPENED = `cs_test_${"v".repeat(24)}`;
const ENVELOPE = COMMANDS.laterPage + COMMANDS.laterCount;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "POST") {
    return new Response(JSON.stringify({ id: OPENED, url: "https://checkout.stripe.com/c/pay/test" }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

/** The registry's rule (964c): a plain command is one; an EVAL is one plus the calls its script makes. */
const billed = (command: (string | number)[]): number =>
  command[0] === "EVAL" ? 1 + (String(command[1]).match(/redis\.call\(/g) ?? []).length : 1;

let sent = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent += billed(command);
  return pipeline(commands);
}) as typeof redis.pipeline;

async function checkout(): Promise<{ status: number; location: string | null; commands: number }> {
  const form = new FormData();
  form.set("handle", "tipenvelope");
  form.set("amount", "other");
  form.set("other", "5");
  form.set(BILLING_COUNTRY_FIELD, "US");
  sent = 0;
  const response = await POST(new NextRequest("https://marktmorgen.com/api/store/tip", {
    method: "POST",
    body: form,
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-for": "203.0.113.9", "x-vercel-ip-country": "US" },
  }));
  return { status: response.status, location: response.headers.get("location"), commands: sent };
}

async function main() {
  const OWNER = "tip-envelope@example.com";
  await claimHandle(OWNER, "tipenvelope", "Tip Envelope", "Pots.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_tipenvelope01", subscriptionId: "sub_tipenvelope01", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_tipenvelope001", true);
  await setTips(OWNER, { on: true, heading: "", line: "", amounts: [] });
  await storeForEmail(OWNER);

  part("A buyer's first tip checkout in the window, the worst case");
  const first = await checkout();
  is("it opens Stripe's page", [first.status, first.location], [303, "https://checkout.stripe.com/c/pay/test"]);
  is(`its ${first.commands} commands stay within one public request's ${ENVELOPE}`, first.commands > 0 && first.commands <= ENVELOPE, true);

  part("A later one in the same window");
  const later = await checkout();
  is("it opens Stripe's page", [later.status, later.location], [303, "https://checkout.stripe.com/c/pay/test"]);
  is(`its ${later.commands} commands stay within one public request's ${ENVELOPE}`, later.commands > 0 && later.commands <= ENVELOPE, true);
  is("and are no more than the first's", later.commands <= first.commands, true);
  done();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
