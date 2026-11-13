/**
 * The daily plan-dispute reader (lib/plan-disputes.ts, syncPlanDisputes) re-reads by id the disputes still open that
 * the provider's list no longer reaches, at most MAX_REREADS a run. With more than MAX_REREADS of them it must not
 * re-read the same first MAX_REREADS every run: a circular cursor moves the window on, so each open dispute is re-read
 * in some run and a late decision is seen (issue #4465, Codex X8).
 */
import { claimHandle, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { MAX_REREADS, SEEN_KEY, syncPlanDisputes } from "@/lib/plan-disputes";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_dispute_closed_only";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const owner = "plan-dispute-closed@example.com";
const handle = "plan-dispute-closed-shop";
const SUB = "sub_PlanDisputeClosed01";
let pages: { data: Record<string, unknown>[]; has_more: boolean }[] = [];
let byId: Record<string, Record<string, unknown>> = {};
const asked: string[] = [];
const byIdReads: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com") {
    asked.push(`${method} ${url.pathname}`);
    if (method !== "GET") return new Response("{}", { status: 400 });
    if (url.pathname === "/v1/disputes") return Response.json(pages[0] ?? { data: [], has_more: false });
    if (url.pathname.startsWith("/v1/disputes/")) {
      const id = url.pathname.split("/").pop() ?? "";
      byIdReads.push(id);
      return byId[id] ? Response.json(byId[id]) : new Response(JSON.stringify({ error: { message: "missing" } }), { status: 404 });
    }
    if (url.pathname === `/v1/subscriptions/${SUB}`) return Response.json({ id: SUB, metadata: { store: handle }, customer: "cus_PlanDisputeClosed01" });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;


async function setup() {
  redis.clear();
  asked.length = 0;
  byId = {};
  pages = [];
  await claimHandle(owner, handle, "Plan dispute closed shop", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_PlanDisputeClosed01", subscriptionId: SUB, active: true, tier: "pro", cycle: "month", period: paidPeriod() });
}

async function seen(): Promise<Map<string, string>> {
  const raw = await redis.run(["HGETALL", SEEN_KEY]);
  const out = new Map<string, string>();
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) out.set(String(raw[i]), String(raw[i + 1]));
  else if (raw && typeof raw === "object") for (const [key, value] of Object.entries(raw)) out.set(key, String(value));
  return out;
}

async function main() {
  part("51 old open disputes, the 51st decided at the bank");
  await setup();
  const store = (await storeForEmail(owner))!;
  const ids = Array.from({ length: MAX_REREADS + 1 }, (_, i) => `du_fixture${String(i).padStart(2, "0")}`);
  for (const id of ids) {
    await redis.run(["HSET", SEEN_KEY, id, `open:${store.sid}`]);
    byId[id] = { id, object: "dispute", status: id === ids[MAX_REREADS] ? "won" : "needs_response", created: NOW - 200 * DAY };
    await recordPlanDispute(storeRef(store), { id, status: "open", at: NOW - 200 * DAY, coversUntil: NOW - 170 * DAY }, NOW);
  }
  pages = [{ data: [], has_more: false }];
  for (const offset of [0, DAY, 2 * DAY]) await syncPlanDisputes(Date.now() + 30_000, NOW + offset);
  const individual = asked.filter((line) => line.startsWith("GET /v1/disputes/")).length;
  const after = await seen();
  console.log("DIAG", JSON.stringify({ individualReads: individual, last: after.get(ids[MAX_REREADS]), first: after.get(ids[0]) }));
  is("the 51st old dispute is read by id in some run", asked.length > 0 && (byIdReads.includes(ids[MAX_REREADS])), true);
  is("and is closed (won)", after.get(ids[MAX_REREADS]), "final");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
