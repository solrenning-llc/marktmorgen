/**
 * Two browser tabs open on the same product: the one opened first saves last.
 *
 * Before this, the stale tab's save answered ok and silently put back what it had
 * loaded: the yearly price, the introductory price, pay what you want, the summary
 * and the long description the other tab had just saved were gone, and nobody was
 * told (docs/cross-product-handoff.md: creator content is never silently lost).
 *
 * Now the studio sends the revision it opened the product at, and the save is
 * refused with 409 "stale" when the product has been saved since: checked and
 * written under the store's own lock (lib/store.ts editProduct), so two saves from
 * the same revision can never both pass. The refusal carries what is saved now, so
 * the editor can show it beside the creator's unsaved words and let them choose.
 *
 * What fails here:
 *   - a stale save that answers ok, or that changes anything on the product;
 *   - two saves racing from the same revision both passing;
 *   - a save from the current revision being refused;
 *   - the refusal not carrying what is saved now (including the long description);
 *   - the editor not sending the revision it opened, or not keeping the creator's words.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { MAX_ABOUT_LENGTH, readAbout } from "@/lib/product-about";
import { MAX_PRODUCT_BYTES } from "@/lib/catalog";
import { PRODUCT_STALE_READ } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = async () => {
  throw Error("No external provider in this test");
};

type Answer = { status: number; body: { ok?: boolean; error?: string; product?: { rev?: number; yearly?: unknown; title?: string } | null; current?: { rev?: number; title?: string; yearly?: { cents: number } | null; about?: string } } };

async function main() {
  redis.clear();
  const owner = "stale-save@example.test";
  await claimHandle(owner, "stale-save", "Synthetic store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_StaleSave", true);
  await setSubscription(owner, { customerId: "cus_StaleSave", subscriptionId: "sub_StaleSave", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Weekly letters", "One letter a week.", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw Error("Real product fixture failed");
  const id = made.product.id;
  const session = await openSession(owner);
  const save = async (body: Record<string, unknown>): Promise<Answer> => {
    const response = await POST(
      new NextRequest("https://marktmorgen.com/api/store/product", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ action: "edit", id, ...body }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Answer["body"] };
  };
  const form = { title: "Weekly letters", summary: "One letter a week.", price: "20", every: "month", trial: "", payments: "", intro: null, yearly: null, pwyw: null, about: "" };

  part("Both tabs open the product at the same revision");
  const opened = (await readListing((await storeForEmail(owner))!, id))!;
  const base = opened.rev ?? 0;
  is("a product as listed carries its revision", typeof opened.rev, "number");

  part("The first tab saves a yearly price and a description");
  const first = await save({ ...form, rev: base, yearly: { price: "200" }, about: "Every letter, in full, kept for members." });
  is("the first save from the opened revision is taken", [first.status, first.body.ok], [200, true]);
  const afterFirst = (await readListing((await storeForEmail(owner))!, id))!;
  is("saving moves the revision on", (afterFirst.rev ?? 0) > base, true);
  is("the answer carries the new revision for the next save", first.body.product?.rev, afterFirst.rev);

  part("The second tab, still at the old revision, saves its own change");
  const stale = await save({ ...form, rev: base, title: "Weekly letters, renamed" });
  is("the stale save is refused as stale, never ok", [stale.status, stale.body.ok, stale.body.error], [409, false, "stale"]);
  const kept = (await readListing((await storeForEmail(owner))!, id))!;
  const shop = (await storeForEmail(owner))!;
  is("the yearly price saved by the first tab is kept", kept.yearly, { cents: 20000 });
  is("the description saved by the first tab is kept", await readAbout(shop.statsId, id), "Every letter, in full, kept for members.");
  is("the title is not changed by the refused save", kept.title, "Weekly letters");
  is("the refused save does not move the revision", kept.rev, afterFirst.rev);
  is("the refusal says what is saved now, with its revision", [stale.body.current?.rev, stale.body.current?.title, stale.body.current?.yearly], [afterFirst.rev, "Weekly letters", { cents: 20000 }]);
  is("including the long description, so the creator can compare", stale.body.current?.about, "Every letter, in full, kept for members.");

  part("A save from the revision now saved is taken, on purpose");
  const chosen = await save({ ...form, rev: stale.body.current?.rev, title: "Weekly letters, renamed", yearly: { price: "200" }, about: "Every letter, in full, kept for members." });
  is("taken", [chosen.status, chosen.body.ok], [200, true]);
  is("with the creator's title", (await readListing((await storeForEmail(owner))!, id))?.title, "Weekly letters, renamed");

  part("Two saves racing from the same revision: one passes, the other is refused");
  const now = (await readListing((await storeForEmail(owner))!, id))!.rev;
  const [a, b] = await Promise.all([save({ ...form, rev: now, title: "Tab A" }), save({ ...form, rev: now, title: "Tab B" })]);
  is("exactly one is taken", [a.body.ok, b.body.ok].filter(Boolean).length, 1);
  is("the other is refused as stale (or the store was busy), never ok", [a, b].filter((x) => !x.body.ok).map((x) => x.body.error === "stale" || x.body.error === "busy"), [true]);
  const winner = a.body.ok ? "Tab A" : "Tab B";
  is("the saved title is the winner's", (await readListing((await storeForEmail(owner))!, id))?.title, winner);

  part("A revision that is not a whole number is refused, not ignored");
  const odd = await save({ ...form, rev: "x" });
  is("refused as invalid", [odd.status, odd.body.ok], [400, false]);

  part("The editor sends the revision it opened and keeps the creator's words on a refusal");
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  is("the edit payload carries the opened revision", /action: "edit", id: product\.id, \.\.\.payload, rev: openedRev }/.test(editor), true);
  is("a stale answer is handled on its own, not as a generic error", /error === "stale"/.test(editor), true);
  const staleBranch = /if \(current && typeof payload\.id === "string"\) \{([\s\S]*?)\n    \}/.exec(editor)?.[1] ?? "";
  is("a stale answer is met in run() without touching the creator's draft", [staleBranch.includes("setStale("), /setDraft|setOpened/.test(staleBranch)], [true, false]);
  is("the saved version replaces the draft only on the creator's own press", /Use the saved version/.test(editor) && /onClick=\{\(\) => \{[\s\S]{0,300}setDraft\(saved\)/.test(editor), true);
  is("the message is announced and takes the focus", /data-stale-notice[\s\S]{0,400}tabIndex=\{-1\}/.test(editor) && /role="alert"/.test(editor), true);
  is("both ways forward are offered by name", /Keep my changes and save/.test(editor) && /Use the saved version/.test(editor), true);

  part("What a refusal reads is counted, in the studio request it is part of");
  is("two reads at most: the listing and the description", PRODUCT_STALE_READ.commands, 2);
  is("bounded by a product's records and the longest description", PRODUCT_STALE_READ.bytes, MAX_PRODUCT_BYTES + MAX_ABOUT_LENGTH * 4);
  const route = readFileSync("app/api/store/product/route.ts", "utf8");
  const refusal = /done\.reason === "stale"\) \{([\s\S]*?)\n      \}/.exec(route)?.[1] ?? "";
  is("the refusal reads only those two, and writes nothing", [(refusal.match(/await /g) ?? []).length, /readListing\(/.test(refusal), /readAbout\(/.test(refusal), /set|write|save/i.test(refusal.replace(/\/\/.*$/gm, ""))], [2, true, true, false]);

  done();
}
void main();
