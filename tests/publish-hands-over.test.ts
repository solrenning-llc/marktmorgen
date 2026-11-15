/**
 * Nothing is published that has nothing to hand over (754 [STN1], unit 2).
 *
 * Publishing a draft (the product route's "visibility" action, hidden false)
 * is refused while the product hands nothing over by the checkout's own rule
 * (lib/product-option.ts handsOver: a file, a link, a course with a lesson, a
 * call, a podcast with an episode, something shipped, or a bundle). It stays
 * hidden, and the editor says what to add. Taking a product off the store is
 * never refused. Once it has a link, it publishes.
 *
 * Once published, it keeps handing something over (Claude 6 on #3432, LOW 1):
 * unlinking the only thing a product on the store hands over, or taking its
 * file off, is refused and the product stays as it was; on a draft it is
 * allowed.
 * Every refusal names the product by its title (LOW 2, WCAG 3.3.1).
 *
 * Synthetic store and products, against the in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductFile, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as attachRoute } from "@/app/api/store/file/attach/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "publisher@example.com";
  await claimHandle(owner, "publisher", "Publisher", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Publxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_pub", subscriptionId: "sub_pub", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const session = await openSession(owner);
  const send = async (body: Record<string, unknown>) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; product?: string } };
  };

  const made = await addProduct(owner, "The Bread Guide", "How I bake every day", "19", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  // The store record changes with every product write, so it is read again each time.
  const listing = async () => readListing((await storeForEmail(owner))!, id);
  const hidden = async () => (await listing())?.hidden;
  await setProductHidden(owner, id, true);
  const draft = await listing();
  is("a draft with nothing to hand over", [draft?.hidden, draft?.file ?? null, draft?.link ?? null], [true, null, null]);

  part("Publishing a product with nothing to hand over is refused, and it stays a draft");
  const early = await send({ action: "visibility", id, hidden: false });
  is("refused, said why", [early.status, early.body.error], [409, "nothing_to_hand_over"]);
  is("the refusal names the product", early.body.product, "The Bread Guide");
  is("still hidden", await hidden(), true);

  part("Taking a product off the store is never refused");
  const off = await send({ action: "visibility", id, hidden: true });
  is("hidden again, fine", [off.status, off.body.ok, await hidden()], [200, true, true]);

  part("With something to hand over, it publishes");
  const linked = await setProductLink(owner, id, "https://example.com/the-bread-guide");
  is("a link added", linked.ok, true);
  const now = await send({ action: "visibility", id, hidden: false });
  is("published", [now.status, now.body.ok, await hidden()], [200, true, false]);

  part("Unlinking the only thing a published product hands over is refused, and nothing changes");
  const unlinked = await send({ action: "unlink", id });
  is("refused, said why, named", [unlinked.status, unlinked.body.error, unlinked.body.product], [409, "last_delivery", "The Bread Guide"]);
  const kept = await listing();
  is("still published, still linked", [kept?.hidden, kept?.link], [false, "https://example.com/the-bread-guide"]);

  part("On a draft, the link can be taken off");
  await send({ action: "visibility", id, hidden: true });
  const draftUnlinked = await send({ action: "unlink", id });
  const bare = await listing();
  is("unlinked, still a draft", [draftUnlinked.status, draftUnlinked.body.ok, bare?.hidden, bare?.link ?? null], [200, true, true, null]);

  part("Taking the file off a published product that hands over nothing else is refused too");
  const filed = await addProduct(owner, "The Starter Sheet", "One page", "9", null);
  if (!filed.ok) throw new Error("no product");
  const fileId = filed.product.id;
  const folder = await storeFolder(owner);
  await setProductFile(owner, fileId, { pathname: `${folder}/${fileId}/starter.pdf`, name: "starter.pdf", bytes: 1000, contentType: "application/pdf", addedAt: new Date().toISOString() });
  const detachReply = await attachRoute(new NextRequest("https://marktmorgen.com/api/store/file/attach", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ id: fileId, detach: true }) }));
  const detached = (await detachReply.json()) as { ok?: boolean; error?: string; product?: string };
  const fileAfter = await readListing((await storeForEmail(owner))!, fileId);
  is("refused, said why, named", [detachReply.status, detached.error, detached.product], [409, "last_delivery", "The Starter Sheet"]);
  is("still published, file kept", [fileAfter?.hidden, fileAfter?.file?.name], [false, "starter.pdf"]);
  is("the store's own setter, used when a plan closes, still takes it off", (await setProductFile(owner, fileId, null)).ok, true);

  part("A price option's link: refused only when it is the last thing the published product hands over");
  const multi = await addProduct(owner, "The Rye Notes", "Two ways in", "29", null);
  if (!multi.ok) throw new Error("no product");
  const multiId = multi.product.id;
  const { addOption } = await import("@/lib/store");
  const one = await addOption(owner, multiId, "PDF", "29");
  const two = await addOption(owner, multiId, "Print", "39");
  if (!one.ok || !two.ok) throw new Error("no options");
  const optionIds = ((await readListing((await storeForEmail(owner))!, multiId))?.options ?? []).map((option) => option.id);
  await setProductLink(owner, optionIds[0], "https://example.com/rye-pdf");
  await setProductLink(owner, optionIds[1], "https://example.com/rye-print");
  const first = await send({ action: "unlink", id: optionIds[0] });
  is("one option still hands over: allowed", [first.status, first.body.ok], [200, true]);
  const last = await send({ action: "unlink", id: optionIds[1] });
  is("the last one: refused, named", [last.status, last.body.error, last.body.product], [409, "last_delivery", "The Rye Notes"]);
  const multiAfter = await readListing((await storeForEmail(owner))!, multiId);
  is("its link is kept", multiAfter?.options.find((option) => option.id === optionIds[1])?.link, "https://example.com/rye-print");

  part("The editor names the product and says what to do, in plain words");
  const words = (await import("@/lib/product-option")) as Record<string, unknown>;
  const said = typeof words.handOverRefusal === "function" ? (words.handOverRefusal as (error: string, product: string | null) => string) : null;
  is("one sentence maker for both refusals", typeof said, "function");
  if (said) {
    is("publishing: names it and says what to add", said("nothing_to_hand_over", "The Bread Guide"), "“The Bread Guide” has nothing to hand over yet. Add what buyers get (a file or link, its lessons, episodes or products), give each price option one, or sell a call at one price, then publish it.");
    is("unlinking: names it and says what to do instead", said("last_delivery", "The Bread Guide"), "“The Bread Guide” is on your store, and this is the only thing it hands over. Put another file or link in its place, or unpublish it first.");
    is("no title: still a whole sentence", said("nothing_to_hand_over", null).startsWith("This product has nothing to hand over yet."), true);
  }
  // Claude 3 on #3432, LOW 1: the sentence fits every kind handsOver refuses (podcast, bundle, call, options).
  const editorSource = readFileSync("components/product-editor.tsx", "utf8");
  is("the editor sends both refusals, with the title, through it", /error === "nothing_to_hand_over" \|\| data\.error === "last_delivery"\) return wrong\(handOverRefusal\(data\.error, typeof \(data as \{ product\?: unknown \}\)\.product === "string"/.test(editorSource), true);

  done();
}

main();
