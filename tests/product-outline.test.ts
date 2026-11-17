/**
 * A ready outline for a product's full description (487 [IT4], item 5; added
 * 2 November 2026): the outline, read by the description's own reader; its
 * prompts found exactly; a product never on the store with one left in, by the
 * product route itself (adding, saving while published, publishing a draft);
 * a draft may keep them; offered only when adding a product with no
 * description yet.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/product/route";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { writeAbout, aboutBlocks, cleanAbout } from "@/lib/product-about";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { PRODUCT_OUTLINE, PRODUCT_OUTLINE_LEFT, PRODUCT_OUTLINE_PROMPTS, productOutlineMessage, productPromptsLeft } from "@/lib/product-outline";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("The outline");
  is("read by the description's own reader as paragraphs and a list, with no figure or quotation of ours", [aboutBlocks(PRODUCT_OUTLINE).some((b) => b.kind === "list"), aboutBlocks(PRODUCT_OUTLINE).some((b) => b.kind === "paragraph"), /\d|“|"/.test(PRODUCT_OUTLINE.replace(/\[[^\]]*\]/g, ""))], [true, true, false]);
  is("its prompts, still found once the server tidies it", productPromptsLeft({ title: "", summary: "", about: cleanAbout(PRODUCT_OUTLINE) }), PRODUCT_OUTLINE_PROMPTS);
  is("from the title and line too; never the creator's own brackets", [productPromptsLeft({ title: "[The first thing inside]", summary: "", about: "" }).length, productPromptsLeft({ title: "[New] Guide", summary: "The [2026] edition", about: "Inside: [bonus]" })], [1, []]);
  const mine = PRODUCT_OUTLINE.replace(/\[[^\]\n]+\]/g, "My own words.");

  part("By the product route itself");
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "outlineshop", "Outline Shop", "Recipes.");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok: boolean; error?: string; left?: string; product?: { id: string } | string } };
  };
  const refused = await call({ action: "add", title: "Recipe Pack", summary: "Thirty dinners.", price: "19", about: PRODUCT_OUTLINE });
  is("adding with prompts left: refused, naming the first, nothing added", [refused.status, refused.data.error, refused.data.left, (await storeForEmail(OWNER))!.catalog.items.length], [409, "outline_left", PRODUCT_OUTLINE_PROMPTS[0], 0]);
  const added = await call({ action: "add", title: "Recipe Pack", summary: "Thirty dinners.", price: "19", about: mine });
  is("every prompt replaced: added", added.data.ok, true);
  const id = (typeof added.data.product === "object" ? added.data.product?.id : undefined) ?? (await storeForEmail(OWNER))!.catalog.items[0]?.id ?? "";
  const edited = await call({ action: "edit", id, title: "Recipe Pack", summary: "Thirty dinners.", price: "19", about: `${mine}\n\n[Who it is for, and who it is not for.]` });
  is("a published product saved with a prompt again: refused, naming it", [edited.status, edited.data.error, edited.data.left], [409, "outline_left", "[Who it is for, and who it is not for.]"]);

  const draft = await addProduct(OWNER, "Draft Pack", "Words.", "9", null, null, true);
  if (!draft.ok) throw new Error("no draft");
  const fresh = (await storeForEmail(OWNER))!;
  await writeAbout(fresh.statsId!, draft.product.id, PRODUCT_OUTLINE, fresh);
  const keep = await call({ action: "edit", id: draft.product.id, title: "Draft Pack", summary: "Words.", price: "9", about: PRODUCT_OUTLINE });
  is("a draft keeps them", keep.data.ok, true);
  const publish = await call({ action: "visibility", id: draft.product.id, hidden: false });
  is("published with prompts left: refused, naming the product and the first part, still a draft", [publish.data.error, publish.data.product, publish.data.left, (await readListing((await storeForEmail(OWNER))!, draft.product.id))?.hidden], ["outline_left", "Draft Pack", PRODUCT_OUTLINE_PROMPTS[0], true]);

  part("In the editor");
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  is("offered when adding a product with no description, decided when the form opens; only into an empty description; the focus moved, the first part selected", [editor.includes("useState(() => !product && !draft.about.trim())"), editor.includes("if (draft.about.trim()) return;"), editor.includes('field.setSelectionRange(start, PRODUCT_OUTLINE.indexOf("]", start) + 1);')], [true, true, true]);
  is("the refusal in words for each case, true for each", [productOutlineMessage("add", "[x]", null), productOutlineMessage("save", null, null), productOutlineMessage("publish", "[x]", "Draft Pack")], ["Replace each part in [brackets] from the outline, brackets and all, with your own words before you add it: it goes on your store at once. The first one left: [x]", "This product is on your store, so it cannot be saved with a part in [brackets] from the outline. Replace each one, brackets and all, with your own words.", "“Draft Pack” still has a part in [brackets] from the outline. Press Edit, replace each one, brackets and all, with your own words, then publish it. The first one left: [x]"]);
  is("chosen by what was pressed, with the route's first part and product", [editor.includes('productOutlineMessage(payload.action === "visibility" ? "publish" : payload.action === "add" ? "add" : "save"'), editor.includes("outline_left: PRODUCT_OUTLINE_LEFT,"), PRODUCT_OUTLINE_LEFT === productOutlineMessage("add", null, null)], [true, true, true]);
  is("once the description has words, a sentence instead of a button that does nothing; after the field's own help", [editor.includes("The outline goes only into an empty description. Clear the description to use it."), editor.indexOf("data-product-outline") > editor.indexOf('? "Reading what you wrote…"'), editor.indexOf("data-product-outline") < editor.indexOf("<TermsCheckPanel")], [true, true, true]);
  const bundle = readFileSync("app/api/store/bundle/route.ts", "utf8");
  is("a bundle, on the store at once, is refused the same way, with words for it", [bundle.includes('if (promptLeft) return Response.json({ ok: false, error: "outline_left", left: promptLeft }, { status: 409 });'), readFileSync("components/bundle-editor.tsx", "utf8").includes("outline_left: PRODUCT_OUTLINE_LEFT,")], [true, true]);
  done();
}

void main();
