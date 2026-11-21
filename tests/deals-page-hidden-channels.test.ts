/**
 * The deals page's "by where people came from" table counts only the deals the person may see (Claude 5's second
 * review of #2036): someone with no access to any pipeline gets the empty board, and the table, if any, adds up none
 * of the store's deals; someone with one pipeline hidden sees only the other's. The real page with a real session,
 * team, access and CRM records (MemoryRedis); no outside request (the creator's Stripe is never asked).
 */
import { NextRequest } from "next/server";
import StudioDealsPage from "@/app/studio/deals/page";
import { DealChannelsLoader } from "@/components/deal-channels-table";
import { POST as CRM } from "@/app/api/store/crm/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { writePipelineAccess } from "@/lib/pipeline-access";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

type Props = { deals: { id: string }[]; stages: { id: string }[] };
function loaderProps(node: unknown): Props | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = loaderProps(child);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    const n = node as { type?: unknown; props?: Props & { children?: unknown; fallback?: unknown } };
    return n.type === DealChannelsLoader ? n.props : loaderProps(n.props?.children);
  }
  return undefined;
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "deals-hidden-owner@example.test";
  const nina = "deals-hidden-nina@example.test";
  await claimHandle(owner, "dealshidden", "Deals Hidden", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_DealsHidden01", subscriptionId: "sub_DealsHidden01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  await putMember(store, nina, "support");
  const cookie = async (who: string) => `${SESSION_COOKIE}=${await openSession(who)}`;
  const crm = async (body: Record<string, unknown>) => {
    const response = await CRM(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: await cookie(owner) }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { deal?: { id: string } } };
  };
  const workshops = { id: "wkshp1", name: "Workshops", stages: [{ id: "wnew01", name: "New", kind: "open" }, { id: "wwon01", name: "Won", kind: "won" }, { id: "wlost1", name: "Lost", kind: "lost" }] };
  is("(the owner adds Workshops)", (await crm({ action: "pipeline", pipeline: workshops, moves: {} })).status, 200);
  const sales = await crm({ action: "deal", deal: { title: "Sales deal", email: "", cents: 9000, stage: "lead00", note: "" } });
  const workshop = await crm({ action: "deal", deal: { title: "Workshop deal", email: "", cents: 11, stage: "wnew01", note: "" } });
  is("(two deals, one in each pipeline)", Boolean(sales.body.deal?.id && workshop.body.deal?.id), true);

  const pageAs = async (who: string) => {
    answering(new NextRequest("https://marktmorgen.com/studio/deals", { headers: { cookie: await cookie(who) } }));
    const page = await StudioDealsPage({ searchParams: Promise.resolve({ store: store.sid }) });
    answering(null);
    return loaderProps(page);
  };

  part("The owner: the table counts every deal");
  const mine = await pageAs(owner);
  is("the owner's table has both deals", mine?.deals.map((d) => d.id).sort(), [sales.body.deal!.id, workshop.body.deal!.id].sort());

  part("No access to any pipeline");
  await writePipelineAccess(store.statsId!, nina, { sales0: "none", wkshp1: "none" }, store);
  const none = await pageAs(nina);
  is("no deal of the store reaches the table", none?.deals.length ?? 0, 0);
  is("no stage of the store reaches the table", none?.stages.length ?? 0, 0);

  part("One pipeline hidden");
  await writePipelineAccess(store.statsId!, nina, { wkshp1: "none" }, store);
  const some = await pageAs(nina);
  is("only the deal she may see reaches the table", some?.deals.map((d) => d.id), [sales.body.deal!.id]);
  is("no stage of the hidden pipeline reaches it", (some?.stages ?? []).some((s) => ["wnew01", "wwon01", "wlost1"].includes(s.id)), false);
  is("no outside request", outside, 0);
  done();
}
void main();
