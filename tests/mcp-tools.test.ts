/**
 * The MCP server's read-only tools beyond the first three (lib/mcp-tools.ts;
 * added 12 October 2026). Checked: memberships and affiliates read as the
 * studio reads them, and nobody named in what an assistant is handed — no
 * address, and no member's own words about why they left.
 */
import { affiliatesTool, membershipsTool, windowOf } from "@/lib/mcp-tools";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_mcp_tools_stand_in";

const OWNER = "owner@example.com";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
let subs: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname === "/v1/subscriptions") return json({ object: "list", data: subs, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  is("the window asked for, or 30 days", [windowOf(7), windowOf("90"), windowOf(45), windowOf(undefined)], ["d7", "d90", "d30", "d30"]);

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const club = await addProduct(OWNER, "Weeknight Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  let store = (await storeForEmail(OWNER))!;

  part("Memberships");
  const member = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    status: "active",
    currency: "usd",
    created: NOW - 90 * DAY,
    start_date: NOW - 90 * DAY,
    customer: { id: `cus_${id.slice(4)}`, email: `${id}@example.com` },
    metadata: { store: "harbor", product: club.product.id, channel: "instagram" },
    items: { data: [{ quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, recurring: { interval: "month", interval_count: 1 } } }] },
    ...over,
  });
  subs = [
    member("sub_Ana000000001"),
    member("sub_Ben000000001"),
    member("sub_Cy0000000001", {
      status: "canceled",
      canceled_at: NOW - 5 * DAY,
      ended_at: NOW - 5 * DAY,
      cancellation_details: { reason: "cancellation_requested", feedback: "too_expensive", comment: "Write to me at cy.private@example.com instead" },
    }),
  ];
  const memberships = await membershipsTool(store, async () => null);
  if (memberships instanceof Response) throw new Error("not charged here");
  const text = JSON.stringify(memberships);
  is("MRR, members and the membership by name", [memberships.mrr, memberships.paying, (memberships.by_product as { product: string }[] | undefined)?.[0]?.product], [4000, 2, "Weeknight Club"]);
  is("why members left, counted and never quoted", [text.includes("too_expensive") || text.includes("expensive"), text.includes("Write to me"), /@/.test(text)], [true, false, false]);

  part("Affiliates");
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 25 });
  store = (await storeForEmail(OWNER))!;
  await redis.pipeline([
    ["HSET", `nl:aff:${store.statsId}:people`, "0123456789ab", JSON.stringify({ id: "0123456789ab", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${store.statsId}:clicks`, "0123456789ab", "12"],
  ]);
  const affiliates = await affiliatesTool(store, async () => null);
  if (affiliates instanceof Response) throw new Error("not charged here");
  is("each by their code, with their clicks", (affiliates.affiliates ?? []).map((a) => [a.code, a.clicks, a.status]), [["sara", 12, "approved"]]);
  is("and never their address", /@/.test(JSON.stringify(affiliates)), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
