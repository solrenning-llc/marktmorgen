/**
 * A refunded plan is taken as ended only once Stripe confirms its own open invoice void and its own draft deleted
 * (#4689, Codex X8). endPlanNow dropped the void and delete answers, so an invoice still open, another invoice's
 * void, or a draft answered `deleted: false` let the plan be written down as ended while the invoice it should have
 * voided stayed payable. Synthetic provider and Redis.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { endPlanNow } from "@/lib/plan-refund-flow";
import type { Store } from "@/lib/store";

const SUB = "sub_M0EndPlan00001";
const OPEN = "in_M0Open000001", OTHER = "in_M0Other00001", DRAFT = "in_M0Draft00001";
let voidAnswer: unknown, draftAnswer: unknown;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  if (url.pathname === `/v1/subscriptions/${SUB}`) return json({ id: SUB, object: "subscription", status: "canceled" });
  if (url.pathname === "/v1/invoices" && method === "GET") {
    const status = url.searchParams.get("status");
    const row = status === "open" ? { id: OPEN, object: "invoice", status: "open" } : { id: DRAFT, object: "invoice", status: "draft" };
    return json({ object: "list", data: [row], has_more: false });
  }
  if (url.pathname === `/v1/invoices/${OPEN}/void`) return json(voidAnswer);
  if (url.pathname === `/v1/invoices/${DRAFT}` && method === "DELETE") return json(draftAnswer);
  return json({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const store = { sid: "m0-endplan-store", email: "owner@example.com", extra: false, subscriptionId: "sub_Another0000001", subscriptionActive: false, assistantPlan: null } as unknown as Store;
  const ownVoid = { id: OPEN, object: "invoice", status: "void" };
  const ownDraftDeleted = { id: DRAFT, object: "invoice", deleted: true };
  part("control: the provider confirms its own invoice void and its own draft deleted");
  voidAnswer = ownVoid; draftAnswer = ownDraftDeleted;
  is("ended", await endPlanNow(store, SUB), true);
  part("a void or delete answer that does not confirm the invoice asked about");
  const cases: [string, unknown, unknown][] = [
    ["own invoice still open", { id: OPEN, object: "invoice", status: "open" }, ownDraftDeleted],
    ["another invoice's void", { id: OTHER, object: "invoice", status: "void" }, ownDraftDeleted],
    ["draft answered deleted:false", ownVoid, { id: DRAFT, object: "invoice", deleted: false }],
  ];
  for (const [what, v, d] of cases) {
    voidAnswer = v; draftAnswer = d;
    is(`${what}: not taken as ended (false, left for the daily job)`, await endPlanNow(store, SUB), false);
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
