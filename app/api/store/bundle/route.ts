import { fastMoneyRefusal } from "@/lib/terms-check-rules";
import { productPromptsLeft } from "@/lib/product-outline";
import type { NextRequest } from "next/server";
import {
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  StoreFullError,
  addProduct,
  removeProduct,
  setProductBundle,
} from "@/lib/store";
import { BUMP_CHOICES, idsOfKind, readCards, readListings } from "@/lib/catalog";
import { MAX_BUNDLE_ITEMS, bundleOwnerProblem, itemsProblem, parsePick, pickProblem, whyNotInBundle } from "@/lib/bundle-rules";
import { jsonAccess } from "@/lib/studio-route";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinLimit } from "@/lib/request-guard";
import { heldRefusal, heldRefusalAmong } from "@/lib/child-safety";

/** Products one page of the picker shows. */
const PICKER_PAGE = 20;

/**
 * The products a bundle can be made of, found by name, a page at a time: the
 * picker in /studio/bundles. `?q=` searches the names, `?page=` moves along,
 * `?for=` is the bundle being edited, left out of its own list. Every product
 * is listed, with the reason it cannot go in when it cannot, so a creator
 * looking for one is told why it is not offered rather than left to wonder.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  // Every page reads the store's cards; a person typing is far below this.
  if (!(await withinLimit("bundle-picker", access.store.sid || access.ref, 240, 600))) {
    return Response.json({ ok: false, error: "slow" }, { status: 429 });
  }
  const params = request.nextUrl.searchParams;
  const query = (params.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
  const page = Math.max(1, Math.min(200, Number(params.get("page")) || 1));
  const owner = params.get("for") ?? "";
  try {
    /*
     * Whether a product can go in a bundle needs things the card does not
     * carry, but the store's own index rules most of a catalogue out before a
     * single read: a membership, a call and a product with price options can
     * never go in one. Names come from the card hash, so the search is one
     * command, and only what survives both is read — at most BUMP_CHOICES,
     * which is far more than a picker showing PICKER_PAGE at a time can reach.
     * This used to read every product in the store on every keystroke.
     */
    const store = access.store;
    const cards = await readCards(store);
    const ruledOut = new Set([...idsOfKind(store, "recurring"), ...idsOfKind(store, "call")]);
    const withOptions = new Set(store.catalog.items.filter((item) => item.options.length > 0).map((item) => item.id));
    const narrowed = [...cards.values()].filter(
      (card) => card.id !== owner && !ruledOut.has(card.id) && !withOptions.has(card.id),
    );
    const named = query ? narrowed.filter((card) => card.title.toLowerCase().includes(query)) : narrowed;
    const listings = await readListings(store, named.slice(0, BUMP_CHOICES).map((card) => card.id));
    const matches = listings;
    // What can go in first, then the rest, each in the creator's own order.
    const sorted = [...matches.filter((p) => !whyNotInBundle(p)), ...matches.filter((p) => whyNotInBundle(p))];
    const from = (page - 1) * PICKER_PAGE;
    const shown = sorted.slice(from, from + PICKER_PAGE).map((p) => ({
      id: p.id,
      title: p.title,
      priceCents: p.priceCents,
      what: p.course ? `Course, ${p.course.lessons} ${p.course.lessons === 1 ? "lesson" : "lessons"}` : p.file ? "Download" : p.link ? "Link" : "",
      hidden: p.hidden,
      why: whyNotInBundle(p),
    }));
    return Response.json(
      { ok: true, products: shown, matches: matches.length, more: from + PICKER_PAGE < sorted.length, page },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("listing products for a bundle failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

/** The list sent, read as ids, each once and at most the most a bundle holds. */
function readItems(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_BUNDLE_ITEMS + 1) return null;
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    out.push(id);
  }
  return out;
}

/**
 * Makes, changes or undoes a bundle.
 *
 *   { action: "save", id, items: [ids], pick? }            what an existing product holds, and how many a buyer chooses
 *   { action: "clear", id }                                back to an ordinary product
 *   { action: "create", title, price, summary, items }     a new product that is a bundle
 *
 * Every rule is checked again here (lib/bundle-rules.ts), under the store's
 * lock, against the products as they are, whatever the page believed.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 8_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body, store } = guarded;
  const action = text(body.action, 10);
  const refuse = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  try {
    // A bundle held for a child-safety report (lib/child-safety.ts) keeps its list, and a held product goes into
    // no bundle, new or old, so nobody is handed it through one. A hold that cannot be read is not a yes.
    if (action === "clear" || action === "save") {
      const held = await heldRefusal(store, text(body.id, 64));
      if (held) return held;
    }
    if (action === "clear") {
      const done = await setProductBundle(ref, text(body.id, 64), null);
      return done.ok ? Response.json({ ok: true }) : refuse(done.reason);
    }
    const items = readItems(body.items);
    if (!items) return refuse("count");
    // How many each buyer chooses, when they build it themselves; null hands over all of them.
    const pick = body.pick === null || body.pick === undefined || body.pick === 0 ? null : parsePick(body.pick);
    if (body.pick && pick === null) return refuse("pick");
    if (pickProblem(pick, items.length)) return refuse("pick");
    const heldItem = await heldRefusalAmong(store, items);
    if (heldItem) return heldItem;

    if (action === "save") {
      const done = await setProductBundle(ref, text(body.id, 64), items, pick);
      return done.ok ? Response.json({ ok: true, id: done.product.id }) : refuse(done.reason);
    }

    if (action === "create") {
      // Checked before the product is made, so a list that cannot be saved
      // never leaves an empty product behind it.
      const early = itemsProblem(items, await readListings(store, items));
      if (early) return refuse(early);
      // A bundle is on the store at once: never with a part of the products' ready outline in its words (lib/product-outline.ts).
      const promptLeft = productPromptsLeft({ title: text(body.title, MAX_TITLE_LENGTH), summary: text(body.summary, MAX_SUMMARY_LENGTH), about: "" })[0];
      if (promptLeft) return Response.json({ ok: false, error: "outline_left", left: promptLeft }, { status: 409 });
      // And what the Terms forbid is refused before it is made (567 [GD1] (d)).
      const refused = fastMoneyRefusal({ title: text(body.title, MAX_TITLE_LENGTH), summary: text(body.summary, MAX_SUMMARY_LENGTH), about: "" });
      if (refused) return Response.json({ ok: false, error: "fast_money", passage: refused }, { status: 409 });
      const added = await addProduct(ref, text(body.title, MAX_TITLE_LENGTH), text(body.summary, MAX_SUMMARY_LENGTH), text(body.price, 20));
      if (!added.ok) return refuse(added.reason, added.reason === "too_many" ? 409 : 400);
      if (bundleOwnerProblem(added.product) === "free") {
        await removeProduct(ref, added.product.id).catch(() => {});
        return refuse("free");
      }
      const done = await setProductBundle(ref, added.product.id, items, pick);
      if (!done.ok) {
        // Something changed in the moment between: nothing half-made is left.
        await removeProduct(ref, added.product.id).catch(() => {});
        return refuse(done.reason);
      }
      return Response.json({ ok: true, id: added.product.id });
    }
    return refuse("invalid");
  } catch (error) {
    if (error instanceof StoreFullError) return refuse("store_full", 409);
    console.error("saving a bundle failed", error);
    return refuse("server_error", 500);
  }
}
