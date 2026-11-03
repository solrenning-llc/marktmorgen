import type { NextRequest } from "next/server";
import { adContext } from "@/lib/ad-context";
import { checkAdText } from "@/lib/ad-creative-check";
import { CAMPAIGN_TAG, LANDING_REFUSALS, landingFrom, landingPage } from "@/lib/campaign-landing";
import { MAX_LANDINGS, readLandings, removeLanding, saveLanding } from "@/lib/campaign-landing-store";
import { readListing } from "@/lib/catalog";
import { readPage } from "@/lib/sales-page-store";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";
import { saleClock } from "@/lib/store-sale";

/**
 * A product's campaign landing pages: 632 [AA2] (m), unit 3. GET
 * `?product=<id>` lists them; POST `{ action: "save", product, campaign,
 * headline, text, button }` keeps one, `{ action: "remove", product,
 * campaign }` takes one off.
 *
 * A landing is saved only from words that pass the ad check here, on the
 * server, against what the store's records say about the product
 * (lib/ad-context.ts): a price, a deadline, a stock limit or a review the
 * product does not have is refused, whatever the request says. The words are
 * refused, never cut, when they do not fit their place on the page, and the
 * page must have a top block to hold them. Part of the product
 * (lib/team-roles.ts): owner, Admin, Editor.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };
const MAX_BODY_BYTES = 8_000;

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const id = (request.nextUrl.searchParams.get("product") ?? "").slice(0, 40);
  const store = access.store;
  if (!store || !id) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  try {
    const product = await readListing(store, id);
    if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
    const [landings, page] = await Promise.all([readLandings(store.statsId, product.id), readPage(store.statsId, product.id)]);
    const hasHero = page.blocks.some((block) => block.kind === "hero");
    return Response.json({ ok: true, landings, most: MAX_LANDINGS, hasHero }, { headers: NO_STORE });
  } catch (error) {
    console.error("reading campaign landings failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const action = body.action === "remove" ? "remove" : body.action === "save" ? "save" : null;
  const id = text(body.product, 40);
  const campaign = typeof body.campaign === "string" ? body.campaign.trim() : "";
  if (!action || !id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  if (!CAMPAIGN_TAG.test(campaign)) return Response.json({ ok: false, error: "campaign", message: LANDING_REFUSALS.campaign }, { status: 400 });
  const statsId = store.statsId;
  if (!statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  try {
    const product = await readListing(store, id);
    if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
    if (action === "remove") {
      await removeLanding(statsId, product.id, campaign, store);
      return Response.json({ ok: true, landings: await readLandings(store.statsId, product.id) }, { headers: NO_STORE });
    }
    const now = saleClock();
    const ad = { headline: text(body.headline, 2_000), text: text(body.text, 2_000), description: "", button: text(body.button, 200) };
    const check = checkAdText(ad, await adContext(store, product, now));
    if (!check.sendable) return Response.json({ ok: false, error: "not_checked", message: LANDING_REFUSALS.not_checked, refusals: check.refusals }, { status: 409 });
    const made = landingFrom(ad, check, campaign);
    if (!made.ok) return Response.json({ ok: false, error: made.error, message: LANDING_REFUSALS[made.error] }, { status: 400 });
    // The page must have a top block to put the words in, now; serving checks again.
    const shown = landingPage(await readPage(store.statsId, product.id), made.landing, now);
    if (!shown.ok) return Response.json({ ok: false, error: shown.error, message: LANDING_REFUSALS[shown.error] }, { status: 409 });
    const saved = await saveLanding(statsId, product.id, made.landing, store);
    if (saved === "full") {
      return Response.json({ ok: false, error: "full", message: `A product keeps landing pages for up to ${MAX_LANDINGS} campaigns. Remove one first.` }, { status: 409 });
    }
    return Response.json({ ok: true, landing: made.landing, warnings: check.warnings, landings: await readLandings(store.statsId, product.id) }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("saving a campaign landing failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
