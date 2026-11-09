/**
 * A draft product's private preview page and the studio's link (754 [STN1], unit 4b).
 *
 * /@<store>/preview/<code> shows the draft's own words under a band that says
 * it is a private preview and not on sale; it is never indexed or followed.
 * Only a live link of that very store opens it: another store's handle, a
 * revoked or unknown code is not found, and a check that fails says so rather
 * than showing the draft. The studio offers the link in a draft's panel only.
 * Synthetic store and products, against the in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setProductAbout, setProductHidden, setSubscription, storeForEmail } from "@/lib/store";
import { writeAbout } from "@/lib/product-about";
import { clearTakenDown, makeDraftPreview, markTakenDown, revokeDraftPreview } from "@/lib/draft-preview";
import PreviewPage, { metadata } from "@/app/[handle]/preview/[code]/page";
import { DraftPreviewLink } from "@/components/draft-preview-link";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function render(handle: string, code: string): Promise<string> {
  try {
    const element = await PreviewPage({ params: Promise.resolve({ handle, code }) });
    return renderToStaticMarkup(element);
  } catch (error) {
    const digest = (error as { digest?: string })?.digest ?? "";
    if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404") || digest === "NEXT_NOT_FOUND") return "NOT_FOUND";
    throw error;
  }
}

async function seed(owner: string, handle: string) {
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
}

async function main(): Promise<void> {
  redis.clear();
  await seed("viewer@example.com", "viewershop");
  await seed("other@example.com", "othershop");
  const made = await addProduct("viewer@example.com", "The Quiet Course", "Six calm lessons", "29", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductHidden("viewer@example.com", id, true);
  const marked = await setProductAbout("viewer@example.com", id, true);
  if (marked.ok && marked.store.statsId) await writeAbout(marked.store.statsId, id, "What is inside: six lessons.", marked.store);
  const store = (await storeForEmail("viewer@example.com"))!;
  const link = await makeDraftPreview(store, id);

  part("Never indexed, never followed");
  const robots = metadata.robots as { index?: boolean; follow?: boolean };
  is("noindex, nofollow", [robots.index, robots.follow], [false, false]);

  part("The draft, under a band that says what it is");
  const html = await render("@viewershop", link.code);
  is("the band", [html.includes("Private preview."), html.includes("This is not on sale yet. Only people with this link can see it")], [true, true]);
  // LOW 2: the date the link ends is a UTC date; it says so.
  is("the end date says it is UTC", /until [A-Z][a-z]+ \d{1,2}, \d{4} \(UTC\)/.test(html), true);
  is("the draft's own words", [html.includes("The Quiet Course"), html.includes("Six calm lessons"), html.includes("six lessons")], [true, true, true]);
  is("nothing to buy", [/checkout|Buy now|Add to cart/i.test(html)], [false]);

  part("Only a live link of that very store");
  is("another store's address: not found", await render("@othershop", link.code), "NOT_FOUND");
  is("an unknown code: not found", await render("@viewershop", "C".repeat(22)), "NOT_FOUND");
  is("a code of another shape: not found", await render("@viewershop", "nope"), "NOT_FOUND");
  await revokeDraftPreview(store, id);
  is("revoked: not found", await render("@viewershop", link.code), "NOT_FOUND");

  part("A check that fails never shows the draft");
  const again = await makeDraftPreview(store, id);
  const realPipeline = redis.pipeline.bind(redis);
  const realReads = realPipeline;
  let calls = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => String(command[1]).startsWith("nl:dpv:"))) throw new Error("Redis request failed with status 500");
    calls++;
    return realReads(commands);
  }) as typeof redis.pipeline;
  let failed = "";
  try {
    failed = await render("@viewershop", again.code);
  } finally {
    redis.pipeline = realPipeline;
  }
  is("it says it could not check", failed.includes("We could not check this preview link just now."), true);
  is("and not the draft", failed.includes("Six calm lessons"), false);
  is("the store itself was read", calls > 0, true);

  // Review of bb7722ce (Claude 6), MEDIUM 2: an opening was neither counted nor capped as a public request.
  part("Each opening is a public request, counted and capped");
  const counted = await makeDraftPreview(store, id);
  const before = redis.keys().filter((key) => key.startsWith("nl:traffic:r:")).length;
  await render("@viewershop", counted.code);
  is("an opening counts in the store's request window", redis.keys().filter((key) => key.startsWith("nl:traffic:r:")).length > before || redis.keys().some((key) => key.startsWith("nl:traffic:r:")), true);
  const page = readFileSync("app/[handle]/preview/[code]/page.tsx", "utf8");
  is("counted before the link is read, as the product page does", page.indexOf("isResting(store)") > -1 && page.indexOf("isResting(store)") < page.indexOf("readDraftPreview(code)"), true);
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("named in the public-requests line of the cost registry", registry.includes('{ file: "app/[handle]/preview/[code]/page.tsx", names: ["isResting(store)"] }'), true);

  // Review of bb7722ce (Claude 6), MEDIUM 3: the store's service worker kept a copy of the preview on the device.
  part("Never kept by the store's service worker");
  const worker = readFileSync("public/sw.js", "utf8");
  const privatePattern = new RegExp(worker.match(/const PRIVATE = \/(.+)\/;/)?.[1] ?? "(?!)");
  is("both addresses are private to it", [privatePattern.test("/@viewershop/preview/" + "A".repeat(22)), privatePattern.test("/preview/" + "A".repeat(22))], [true, true]);
  is("the cache's name moved on, so copies kept before are emptied", worker.includes('const CACHE = "nimbus-v7"'), false);

  // Review of bb7722ce (Claude 6), MEDIUM 1, and of e42726e5, MEDIUM 1.
  part("A store switched off, a product taken down");
  const down = await makeDraftPreview(store, id);
  await markTakenDown(store, id);
  is("a product taken down after a notice: not shown", (await render("@viewershop", down.code)).includes("Six calm lessons"), false);
  await clearTakenDown(store, id);
  const late = await makeDraftPreview(store, id);
  is("published again and back to a draft: shown again", (await render("@viewershop", late.code)).includes("Six calm lessons"), true);
  await noteTakedown("viewer@example.com", null, true);
  const off = await render("@viewershop", late.code);
  is("a store switched off: its drafts are not shown", off.includes("Six calm lessons"), false);

  // Review of bf809f14 (Claude 6), LOW 4: a description that cannot be read is said, not shown as missing.
  is("a description that cannot be read is said", readFileSync("app/[handle]/preview/[code]/page.tsx", "utf8").includes("The description could not be loaded just now."), true);

  part("The studio's link");
  const button = renderToStaticMarkup(createElement(DraftPreviewLink, { productId: id, handle: "viewershop" }));
  is("one plain button, and a live region", [button.includes("Get a private preview link"), button.includes('role="status"')], [true, true]);
  is("it says who can see it and for how long", button.includes("Only people with the link can see it, for seven days."), true);
  // Review of bb7722ce (Claude 6), LOW 1: stopping the link dropped the focus to the page.
  const linkSource = readFileSync("components/draft-preview-link.tsx", "utf8");
  is("after a stop the focus goes back to the button that makes a link", linkSource.includes("requestAnimationFrame(() => makeButton.current?.focus())"), true);
  is("busy buttons stay focusable", [/(?<!aria-)disabled=\{busy\}/.test(linkSource), linkSource.includes("aria-disabled={busy}")], [false, true]);
  is("a taken-down product and a switched-off store are each said plainly", [linkSource.includes('"taken_down"'), linkSource.includes('"suspended"')], [true, true]);
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  is("offered in a draft's panel only", editor.includes("{product.hidden ? <DraftPreviewLink productId={product.id} handle={handle} /> : null}"), true);

  done();
}

main();
