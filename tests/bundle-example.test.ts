/**
 * 487 [IT4], item 5 (no empty screen without a ready example), bundles: "Start from an example".
 *
 * The audit (docs/ease-patterns-audit.md, Pattern 5) found that a new bundle had a sentence and a button but no
 * ready example. Its name and its one line can now start from an example (lib/bundle-example.ts) that sets out what
 * a buyer looks for in them, every part the creator writes in [brackets]. It holds nothing but those prompts: no
 * price, no product chosen, no figure, no claim. The price and what goes in it stay the creator's.
 *
 * A bundle is on the store the moment it is made, so it is never made with one of those prompts left: the editor
 * says so before it asks the server, and the bundle route refuses it with "outline_left" before anything is made.
 * The prompts are among those productPromptsLeft looks for, so the product route keeps refusing them once the
 * bundle is a product on the store. Only the exact prompts are looked for: the creator's own brackets never count.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/bundle/route";
import { POST as productPOST } from "@/app/api/store/product/route";
import { addProduct, claimHandle, ensureStatsId, setProductLink, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH } from "@/lib/catalog";
import { BUNDLE_EXAMPLE, BUNDLE_EXAMPLE_PROMPTS, bundleExampleMessage } from "@/lib/bundle-example";
import { PRODUCT_OUTLINE, PRODUCT_OUTLINE_PROMPTS, productPromptsLeft } from "@/lib/product-outline";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("The example");
  const both = [BUNDLE_EXAMPLE.title, BUNDLE_EXAMPLE.summary];
  is("the name and the line are each one prompt in [brackets], nothing else", both.every((words) => /^\[[^\]\n]+\]$/.test(words)), true);
  is("two prompts, each once, none of them a product outline's", [BUNDLE_EXAMPLE_PROMPTS, BUNDLE_EXAMPLE_PROMPTS.some((p) => PRODUCT_OUTLINE_PROMPTS.includes(p))], [both, false]);
  is("no figure, no price, no quotation", /\d|\$|“|"/.test(both.join(" ")), false);
  is("fit the name and the line", [BUNDLE_EXAMPLE.title.length <= MAX_TITLE_LENGTH, BUNDLE_EXAMPLE.summary.length <= MAX_SUMMARY_LENGTH], [true, true]);
  is("the name says what is in it; the line, what a buyer can do with it and who it is for", [/what is in it/.test(BUNDLE_EXAMPLE.title), /who it is for/.test(BUNDLE_EXAMPLE.summary)], [true, true]);

  part("A prompt left is found where products' are");
  is("in the name and the line, in the order they appear", productPromptsLeft({ title: BUNDLE_EXAMPLE.title, summary: BUNDLE_EXAMPLE.summary, about: "" }), BUNDLE_EXAMPLE_PROMPTS);
  is("one left among the creator's words", productPromptsLeft({ title: "The bread kit", summary: BUNDLE_EXAMPLE.summary, about: "" }), [BUNDLE_EXAMPLE.summary]);
  is("never the creator's own brackets", productPromptsLeft({ title: "[New] The bread kit", summary: "Every [2026] recipe.", about: "" }), []);
  is("the product outline's prompts still found as before", productPromptsLeft({ title: "", summary: "", about: PRODUCT_OUTLINE }), PRODUCT_OUTLINE_PROMPTS);
  is("what the editor says names the brackets, that it goes on the store at once, and the first part left", bundleExampleMessage("[x]"), "Replace each part in [brackets] from the example with your own words, including the brackets, before you add the bundle: it goes on your store at once. The first one left: [x]");
  is("and without one named", bundleExampleMessage(null), "Replace each part in [brackets] from the example with your own words, including the brackets, before you add the bundle: it goes on your store at once.");

  part("By the bundle route itself");
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "bundleshop", "Bundle Shop", "Recipes.");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const ids: string[] = [];
  for (const title of ["Bread", "Soup"]) {
    const made = await addProduct(OWNER, title, "Recipes.", "10");
    if (!made.ok) throw new Error("no product");
    await setProductLink(OWNER, made.product.id, `https://example.com/${title.toLowerCase()}`);
    ids.push(made.product.id);
  }
  const count = async () => (await storeForEmail(OWNER))!.catalog.items.length;
  const call = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/bundle", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok: boolean; error?: string; left?: string; id?: string } };
  };
  const refused = await call({ action: "create", title: BUNDLE_EXAMPLE.title, summary: BUNDLE_EXAMPLE.summary, price: "15", items: ids, pick: null });
  is("made with the example left: refused, naming the first part, nothing made", [refused.status, refused.data.error, refused.data.left, await count()], [409, "outline_left", BUNDLE_EXAMPLE.title, 2]);
  const line = await call({ action: "create", title: "The soup and bread kit", summary: BUNDLE_EXAMPLE.summary, price: "15", items: ids, pick: null });
  is("the line still the example's: refused, naming it, nothing made", [line.status, line.data.error, line.data.left, await count()], [409, "outline_left", BUNDLE_EXAMPLE.summary, 2]);
  const made = await call({ action: "create", title: "The soup and bread kit", summary: "Both recipe sets, for a [winter] week of dinners.", price: "15", items: ids, pick: null });
  is("the creator's own words, brackets of their own included: made", [made.data.ok, await count()], [true, 3]);

  part("Later, as a product on the store");
  const product = async (body: Record<string, unknown>) => {
    const response = await productPOST(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok: boolean; error?: string; left?: string } };
  };
  const edited = await product({ action: "edit", id: made.data.id, title: BUNDLE_EXAMPLE.title, summary: "Both recipe sets.", price: "15", about: "" });
  is("saved on the store with the example's name: refused by the product route, naming it", [edited.status, edited.data.error, edited.data.left], [409, "outline_left", BUNDLE_EXAMPLE.title]);

  part("The editor");
  const editor = readFileSync("components/bundle-editor.tsx", "utf8");
  is("offers the example under a new bundle's name and line, explained by its help", [editor.includes("Start from an example"), /aria-describedby="bundle-example-help"/.test(editor), editor.includes('id="bundle-example-help"')], [true, true, true]);
  is("only in a new bundle", editor.indexOf("data-bundle-example") > editor.indexOf('{mode === "create" ? (') && editor.indexOf("data-bundle-example") < editor.indexOf("In it: ${items.length}"), true);
  is("only into an empty name and line: nothing typed is replaced", /if \(title\.trim\(\) \|\| summary\.trim\(\)\) return;\s*setTitle\(BUNDLE_EXAMPLE\.title\);\s*setSummary\(BUNDLE_EXAMPLE\.summary\);/.test(editor), true);
  is("once either has words, a sentence instead of a button that does nothing", editor.includes("The example goes only into an empty name and line. Clear them to use it."), true);
  is("the focus goes to the name, its part selected", editor.includes("field.setSelectionRange(0, BUNDLE_EXAMPLE.title.length);"), true);
  const save = editor.slice(editor.indexOf("async function save()"), editor.indexOf("async function clear()"));
  const check = save.indexOf("productPromptsLeft({ title, summary, about: \"\" })[0]");
  is("refused before the server is asked, with the first part left", check > -1 && check < save.indexOf("await post("), true);
  is("the route's refusal has its words and names the part", editor.includes('data.error === "outline_left" ? bundleExampleMessage(data.left ?? null)'), true);
  is("the help says the price and the products stay the creator's", editor.includes("The price and what goes in it stay yours to choose."), true);

  done();
}

void main();
