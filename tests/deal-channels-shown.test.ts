/**
 * The deals page (app/studio/deals/page.tsx) shows a teammate only the
 * pipelines the store lets them see (639 [GL7](7)). The table by channel under
 * the board (components/deal-channels-table.tsx) counts and adds up the deals
 * it is handed, so it must be handed the same deals and stages as the board:
 * a deal in a pipeline hidden from the teammate is never counted there,
 * neither its number nor its value. The real page, session, team, pipeline
 * access and CRM reads; Stripe stubbed with no sales; nothing real.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StudioDealsPage from "@/app/studio/deals/page";
import { DealChannelsLoader } from "@/components/deal-channels-table";
import { DealsBoard } from "@/components/deals-board";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { savePipelineChange, writeDeal } from "@/lib/crm";
import { DEFAULT_STAGES, type Deal, type Pipeline, pipelineLimit } from "@/lib/crm-rules";
import { writePipelineAccess } from "@/lib/pipeline-access";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

/** The first element of `type` in the tree the page returned, without drawing anything. */
function find(node: ReactNode, type: unknown): Element | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as Element;
  if (element.type === type) return element;
  return find(element.props.children, type);
}

const deal = (id: string, title: string, cents: number, stage: string): Deal => ({ id, title, email: "", cents, stage, note: "", createdAt: 1, updatedAt: 1 });

async function main(): Promise<void> {
  redis.clear();
  cookieValues.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_deal_channels_shown_stand_in";
  const owner = "deals-shown@example.com";
  await claimHandle(owner, "dealsshown", "Deals Shown", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestDealShown1", true);
  await setSubscription(owner, { customerId: "cus_DealShown001", subscriptionId: "sub_DealShown001", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const workshops: Pipeline = { id: "wkshp1", name: "Workshops", stages: [{ id: "wnew01", name: "New", kind: "open" }, { id: "wwon01", name: "Won", kind: "won" }, { id: "wlost1", name: "Lost", kind: "lost" }] };
  const added = await savePipelineChange(statsId, { pipeline: workshops }, {}, pipelineLimit(store), store);
  is("(the store has a second pipeline)", added.ok, true);
  is("(a deal in the first pipeline)", await writeDeal(statsId, deal("dealsee001", "Seen deal", 50_000, DEFAULT_STAGES[0].id), store), true);
  is("(a deal in the second pipeline)", await writeDeal(statsId, deal("dealhid001", "Hidden deal", 777_700, "wnew01"), store), true);
  await putMember(store, "sam@example.com", "support");
  await writePipelineAccess(statsId, "sam@example.com", { wkshp1: "none" }, store);

  const page = async (who: string) => {
    cookieValues.set(SESSION_COOKIE, await openSession(who));
    return StudioDealsPage({ searchParams: Promise.resolve({ store: store.sid }) });
  };
  const ids = (deals: unknown) => (deals as Deal[]).map((d) => d.id).sort();
  const stageIds = (stages: unknown) => (stages as { id: string }[]).map((s) => s.id);

  part("A teammate kept out of the second pipeline");
  const sam = await page("sam@example.com");
  const board = find(sam, DealsBoard);
  const loader = find(sam, DealChannelsLoader);
  is("control: the board is drawn with the first pipeline's deal only", ids(board?.props.deals), ["dealsee001"]);
  is("the table by channel is handed the same deals as the board", ids(loader?.props.deals), ids(board?.props.deals));
  is("and the same stages, none of the hidden pipeline's", [stageIds(loader?.props.stages), stageIds(loader?.props.stages).includes("wnew01")], [stageIds(board?.props.stages), false]);
  const table = loader ? renderToStaticMarkup(await DealChannelsLoader(loader.props as Parameters<typeof DealChannelsLoader>[0])) : "";
  const text = table.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  is("the table neither counts the hidden deal nor adds its value", [/All deals 1 · \$500 /.test(text), /7,777|8,277/.test(text)], [true, false]);

  part("The owner still sees every pipeline in both");
  const mine = await page(owner);
  is("the owner's table has both deals, as the owner's board", [ids(find(mine, DealChannelsLoader)?.props.deals), ids(find(mine, DealsBoard)?.props.deals)], [["dealhid001", "dealsee001"], ["dealhid001", "dealsee001"]]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
