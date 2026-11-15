/**
 * 568 [GD2] (c), funnel pages: the offers a buyer sees after paying may not pose as Marktmorgen itself.
 *
 * A funnel's offers are drawn on the thanks page, the moment right after a card was used, which is when "Marktmorgen
 * Support: verify your card to receive your download" works best on a buyer. A funnel's own pages are the store's
 * own pages and products' pages, already held to the same rule where they are written (app/api/store/site-page,
 * app/api/store/page, app/api/store/product); what only a funnel holds is each offer's headline and text. With the
 * real route on the in-memory database and a real session (app/api/store/funnel):
 *
 *   - an offer whose headline or text poses is refused with "brand_imitation", which offer, which part, the passage,
 *     why (said of an offer) and the fix, and nothing is saved;
 *   - plain offers, and saying the store runs on Marktmorgen, are saved;
 *   - the funnel editor says it naming the offer and the part, with nothing the creator wrote changed.
 *
 * Synthetic store and data only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, storeForEmail } from "@/lib/store";
import { readAllListings, readProduct } from "@/lib/catalog";
import { IMITATION_FIX, imitationMessage, imitationWhy } from "@/lib/brand-imitation-rules";
import { offerPart } from "@/components/funnel-editor";
import { POST as funnelRoute } from "@/app/api/store/funnel/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ORIGIN = "https://marktmorgen.com";
const OWNER = "posing.offers@example.com";
type Json = Record<string, unknown> & { ok?: boolean; error?: string; passage?: { field?: string; offer?: number; excerpt?: string; why?: string; fix?: string } };
const OFFER_WHY = imitationWhy("the offer cannot be shown with it");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "posingoffers", "Posing Offers", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const add = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error(`could not add ${title}`);
    await setProductLink(OWNER, made.product.id, `https://example.com/files/${made.product.id}`);
    return made.product.id;
  };
  const guide = await add("Guide", "29");
  const notes = await add("Notes", "19");
  const extra = await add("Extra", "15");
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE}=${session}` };
  const save = async (steps: { headline?: string; text?: string }[]): Promise<Json & { status: number }> => {
    const ids = ["nts001", "ext001"];
    const funnel = { steps: steps.map((step, i) => ({ id: ids[i], productId: i === 0 ? notes : extra, price: i === 0 ? "19" : "15", headline: step.headline ?? "", text: step.text ?? "", imageFrom: null, yes: null, no: i === 0 && steps.length > 1 ? ids[1] : null })) };
    const response = await funnelRoute(new NextRequest(`${ORIGIN}/api/store/funnel`, { method: "POST", headers, body: JSON.stringify({ id: guide, funnel }) }));
    return { status: response.status, ...((await response.json().catch(() => ({}))) as Json) };
  };
  const saved = async () => (await readAllListings((await storeForEmail(OWNER))!)).find((listing) => listing.id === guide);
  const offers = async () => {
    const product = await readProduct((await storeForEmail(OWNER))!, guide);
    return product?.funnel?.steps.map((step) => [step.headline, step.text]) ?? null;
  };

  part("A plain funnel is saved");
  const plain = await save([{ headline: "Add the notes", text: "Sold on Marktmorgen, like the guide." }]);
  is("saved", [plain.status, plain.ok, await offers()], [200, true, [["Add the notes", "Sold on Marktmorgen, like the guide."]]]);
  is("the product is still there", Boolean(await saved()), true);

  part("An offer that poses is refused, and nothing is saved");
  const headline = await save([{ headline: "Marktmorgen Support: confirm your card to get the guide" }]);
  is("a headline posing as Marktmorgen's staff: which offer, which part, the passage, why and the fix", [headline.status, headline.error, headline.passage?.field, headline.passage?.offer, headline.passage?.excerpt?.includes("Marktmorgen Support"), headline.passage?.why, headline.passage?.fix], [409, "brand_imitation", "headline", 1, true, OFFER_WHY, IMITATION_FIX]);
  is("the funnel is left as it was", await offers(), [["Add the notes", "Sold on Marktmorgen, like the guide."]]);
  const second = await save([{ headline: "Add the notes" }, { text: "Your Marktmorgen account has been suspended until you verify it." }]);
  is("the text of a later offer: offer 2, the text", [second.status, second.error, second.passage?.field, second.passage?.offer], [409, "brand_imitation", "text", 2]);
  const link = await save([{ text: "Download it at https://marktmorgen-login.com/files" }]);
  is("a look-alike address in an offer", [link.status, link.error], [409, "brand_imitation"]);
  const password = await save([{ text: "Enter your Marktmorgen password to unlock the notes." }]);
  is("a password asked in Marktmorgen's name", [password.status, password.error], [409, "brand_imitation"]);
  is("and still nothing was saved", await offers(), [["Add the notes", "Sold on Marktmorgen, like the guide."]]);

  part("The protective opposite passes");
  const opposite = await save([{ headline: "Add the notes", text: "Marktmorgen will never ask for your password." }]);
  is("saved", [opposite.status, await offers()], [200, [["Add the notes", "Marktmorgen will never ask for your password."]]]);

  part("The funnel editor says it");
  is("which offer and which part", [offerPart({ field: "headline", offer: 1 }), offerPart({ field: "text", offer: 2 }), offerPart({ field: "text", offer: "2" }), offerPart(undefined)], ["the headline of offer 1", "the text of offer 2", "the text of an offer", "the text of an offer"]);
  is("the sentence", imitationMessage(headline.passage, offerPart(headline.passage), "Your changes were not saved").startsWith("Your changes were not saved. In the headline of offer 1: “Marktmorgen Support"), true);
  is("the editor uses it", /if \(data\.error === "brand_imitation"\) return setError\(imitationMessage\(data\.passage, offerPart\(data\.passage\), "Your changes were not saved"\)\);/.test(readFileSync("components/funnel-editor.tsx", "utf8")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
