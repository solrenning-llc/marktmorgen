import type { NextRequest } from "next/server";
import { AD_CONTEXT_UNITS, adContext, pageReadUnits } from "@/lib/ad-context";
import { checkAdText } from "@/lib/ad-creative-check";
import { CAMPAIGN_TAG, LANDING_REFUSALS, landingFrom, landingPage } from "@/lib/campaign-landing";
import { LandingIdInvalid, LandingsGone, LandingsUnreadable, LandingsWriteUnconfirmed, MAX_LANDINGS, readLandings, removeLanding, saveLanding } from "@/lib/campaign-landing-store";
import { studioRefusal } from "@/lib/person-tasks";
import { readListing } from "@/lib/catalog";
import { PageGrown, keptPageBytes, readPageWithin } from "@/lib/sales-page-store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { countStudio, jsonAccess } from "@/lib/studio-route";
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
    // The page is measured first and its reading counted, past the request's own unit (Claude 5 on #1950).
    const bytes = await keptPageBytes(store.statsId, product.id);
    const counted = pageReadUnits(bytes) > 0 ? await countStudio(store, null, pageReadUnits(bytes)) : ({ ok: true } as const);
    if (!counted.ok) {
      const refused = studioRefusal(counted.reason, counted.message);
      return Response.json(refused.body, { status: refused.status, headers: NO_STORE });
    }
    const [landings, page] = await Promise.all([readLandings(store.statsId, product.id), readPageWithin(store.statsId, product.id, bytes)]);
    const hasHero = page.blocks.some((block) => block.kind === "hero");
    return Response.json({ ok: true, landings, most: MAX_LANDINGS, hasHero }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof PageGrown) return Response.json({ ok: false, error: "changed", message: error.message }, { status: 409 });
    if (error instanceof UnknownReplyError) return Response.json({ ok: false, error: "unavailable", message: "This could not be read just now. Try again in a moment." }, { status: 503 });
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
    // The check reads the product's reviews, counted first at their heaviest (AD_CONTEXT_UNITS), and the save reads
    // its page, measured and counted first too (pageReadUnits; Claude 5 on #1950).
    const bytes = await keptPageBytes(store.statsId, product.id);
    const counted = await countStudio(store, null, AD_CONTEXT_UNITS + pageReadUnits(bytes));
    if (!counted.ok) {
      const refused = studioRefusal(counted.reason, counted.message);
      return Response.json(refused.body, { status: refused.status, headers: NO_STORE });
    }
    const now = saleClock();
    const ad = { headline: text(body.headline, 2_000), text: text(body.text, 2_000), description: "", button: text(body.button, 200) };
    const check = checkAdText(ad, await adContext(store, product, now));
    if (!check.sendable) return Response.json({ ok: false, error: "not_checked", message: LANDING_REFUSALS.not_checked, refusals: check.refusals }, { status: 409 });
    const made = landingFrom(ad, check, campaign);
    if (!made.ok) return Response.json({ ok: false, error: made.error, message: LANDING_REFUSALS[made.error] }, { status: 400 });
    // The page must have a top block to put the words in, now; serving checks again.
    const shown = landingPage(await readPageWithin(store.statsId, product.id, bytes), made.landing, now);
    if (!shown.ok) return Response.json({ ok: false, error: shown.error, message: LANDING_REFUSALS[shown.error] }, { status: 409 });
    const saved = await saveLanding(statsId, product.id, made.landing, store);
    if (saved === "full") {
      return Response.json({ ok: false, error: "full", message: `A product keeps landing pages for up to ${MAX_LANDINGS} campaigns. Remove one first.` }, { status: 409 });
    }
    return Response.json({ ok: true, landing: made.landing, warnings: check.warnings, landings: await readLandings(store.statsId, product.id) }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    if (error instanceof PageGrown) return Response.json({ ok: false, error: "changed", message: error.message }, { status: 409 });
    if (error instanceof UnknownReplyError) return Response.json({ ok: false, error: "unavailable", message: "This could not be read just now. Nothing was saved. Try again in a moment." }, { status: 503 });
    // Not read exactly: nothing was saved (Codex G and J, #1947/#1950). Its answer lost: it may have been, so the page is read again.
    if (error instanceof LandingsUnreadable) return Response.json({ ok: false, error: "unavailable", message: error.message }, { status: 503 });
    if (error instanceof LandingsWriteUnconfirmed) return Response.json({ ok: false, error: "unconfirmed", message: error.message }, { status: 503 });
    // The product's page was deleted while this was saved: nothing was kept, and the reason is said (Claude 5 on #1950).
    if (error instanceof LandingsGone) return Response.json({ ok: false, error: "gone", message: "This product's page was removed, so the landing page was not saved. Reload the page." }, { status: 410 });
    if (error instanceof LandingIdInvalid) return Response.json({ ok: false, error: "unknown", message: error.message }, { status: 400 });
    console.error("saving a campaign landing failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
