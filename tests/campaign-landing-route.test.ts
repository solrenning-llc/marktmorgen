/**
 * 632 [AA2] (m), unit 3: the studio's route for a product's campaign landing
 * pages (app/api/store/campaign-landing/route.ts), through the real route,
 * session and store. A landing is kept only from words that pass the ad
 * check on the server, against the store's own records; words that do not
 * fit are refused, never cut; the page needs a top block; a product keeps at
 * most ten; one can be taken off.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/campaign-landing/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MAX_LANDINGS, readLandings } from "@/lib/campaign-landing-store";
import { MAX_HEADLINE, parsePage } from "@/lib/sales-page";
import { writePage } from "@/lib/sales-page-store";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; refusals?: { rule: string }[]; landings?: { campaign: string; headline: string }[]; hasHero?: boolean };

async function main(): Promise<void> {
  redis.clear();
  const owner = "landing@example.com";
  await claimHandle(owner, "landingshop", "Landing Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_landing", subscriptionId: "sub_landing", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Knife Skills", "", "40");
  const product = made.ok ? made.product.id : "";
  const session = await openSession(owner);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/campaign-landing", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const get = async (id: string) => {
    const response = await GET(new NextRequest(`https://marktmorgen.com/api/store/campaign-landing?product=${id}`, { headers: { cookie } }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const save = (over: Record<string, unknown> = {}) =>
    post({ action: "save", product, campaign: "spring-sale", headline: "Cook a real dinner in twenty minutes", text: "A short course on knife skills, for $40.", button: "Start cooking", ...over });
  const store = (await storeForEmail(owner))!;

  part("A page with no top block cannot hold the ad's words");
  is("refused, saying what to add", [(await save()).status, (await save()).body.error], [409, "no_hero"]);
  is("the list says so", (await get(product)).body.hasHero, false);
  await writePage(store.statsId!, product, parsePage({ blocks: [{ id: "hero0001", kind: "hero", headline: "Knife Skills", sub: "", media: "none", video: null }] }), store);

  part("Saved from words that pass the check");
  const first = await save();
  is("saved", [first.status, first.body.ok, first.body.landings?.map((one) => one.campaign)], [200, true, ["spring-sale"]]);
  is("listed for the studio", (await get(product)).body.landings?.map((one) => one.headline), ["Cook a real dinner in twenty minutes"]);
  is("kept in the store", (await readLandings(store.statsId, product)).length, 1);

  part("Codex J (#1950): a read answered short never lets a save erase the landings already kept");
  const landingKey = `nl:product:landing:${store.statsId}:${product}`;
  for (const shape of [[], [undefined], ["{broken"]] as unknown[][]) {
    const pipeline = redis.pipeline;
    let cut = false;
    redis.pipeline = async (commands) => {
      if (!cut && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === landingKey) {
        cut = true;
        return shape;
      }
      return pipeline(commands);
    };
    let other: { status: number; body: { ok?: boolean; error?: string } };
    try {
      other = await save({ campaign: "fall-sale" });
    } finally {
      redis.pipeline = pipeline;
    }
    is(`answered ${JSON.stringify(shape)}: 503, not saved, and "spring-sale" still kept`, [cut, other.status, other.body.ok, other.body.error, (await readLandings(store.statsId, product)).map((one) => one.campaign)], [true, 503, false, "unavailable", ["spring-sale"]]);
  }

  part("Refused by the ad check, on the server");
  const price = await save({ campaign: "wrong-price", text: "Yours for $19 only." });
  is("a price that is not the product's", [price.status, price.body.error, price.body.refusals?.map((one) => one.rule)], [409, "not_checked", ["price_mismatch"]]);
  is("urgency with no real sale", (await save({ campaign: "hurry", text: "Ends tonight, hurry!" })).body.error, "not_checked");
  is("a quote that is not a verified review", (await save({ campaign: "quote", text: "“Best course ever” — Ana" })).body.error, "not_checked");
  is("none of them kept", (await readLandings(store.statsId, product)).map((one) => one.campaign), ["spring-sale"]);

  part("Words that do not fit are refused, never cut");
  is("a headline too long for the top of the page", (await save({ campaign: "long", headline: "h".repeat(MAX_HEADLINE + 1) })).body.error, "headline_long");
  is("a button too long", (await save({ campaign: "long", button: "b".repeat(41) })).body.error, "button_long");
  is("no headline", (await save({ campaign: "long", headline: "" })).body.error, "headline");
  is("a campaign tag that is not one", [(await save({ campaign: "Spring Sale" })).status, (await save({ campaign: "Spring Sale" })).body.error], [400, "campaign"]);
  is("a product that is not the store's", (await save({ product: "nope" })).body.error, "unknown");

  part(`At most ${MAX_LANDINGS} a product, and one can go`);
  for (let n = 2; n <= MAX_LANDINGS; n += 1) await save({ campaign: `c${n}` });
  is("ten kept", (await readLandings(store.statsId, product)).length, MAX_LANDINGS);
  is("an eleventh refused", [(await save({ campaign: "c11" })).status, (await save({ campaign: "c11" })).body.error], [409, "full"]);
  is("one already there can still change", (await save({ headline: "Dinner, sharper" })).body.ok, true);
  const removed = await post({ action: "remove", product, campaign: "c2" });
  is("taken off", [removed.body.ok, removed.body.landings?.some((one) => one.campaign === "c2")], [true, false]);
  is("an action that is not one", (await post({ action: "launch", product, campaign: "c3" })).body.error, "unknown");

  part("Only for the store's own team");
  const stranger = await POST(new NextRequest("https://marktmorgen.com/api/store/campaign-landing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remove", product, campaign: "c3" }) }));
  is("no session: refused", stranger.status >= 400 && stranger.status < 500, true);
  is("and nothing removed", (await readLandings(store.statsId, product)).some((one) => one.campaign === "c3"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
