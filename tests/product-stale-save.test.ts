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

  part("A refusal never adopts the middle of the save that won");
  // Stop the winning request just after its first store lock is released. Before
  // this fix, editProduct had already moved rev on, but the yearly price and the
  // description were still written later under separate locks. The losing tab
  // could therefore adopt that incomplete snapshot and erase both on its retry.
  const plainPipeline = redis.pipeline.bind(redis);
  let openGate!: () => void;
  let sawRelease!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  const released = new Promise<void>((resolve) => { sawRelease = resolve; });
  let holdFirstStoreRelease = true;
  redis.pipeline = async (commands) => {
    const reply = await plainPipeline(commands);
    const release = commands.some((command) =>
      command[0] === "EVAL" &&
      String(command[1]).startsWith("-- marktmorgen:release:v1\n") &&
      String(command[3]).startsWith("nl:store:lock:"),
    );
    if (holdFirstStoreRelease && release) {
      holdFirstStoreRelease = false;
      sawRelease();
      await gate;
    }
    return reply;
  };
  const openedBeforeWholeSave = (await readListing((await storeForEmail(owner))!, id))!.rev ?? 0;
  const winnerSave = save({ ...form, rev: openedBeforeWholeSave, yearly: { price: "200" }, about: "The complete winning description." });
  await released;
  const middle = await save({ ...form, rev: openedBeforeWholeSave, title: "The losing tab" });
  openGate();
  const winnerAnswer = await winnerSave;
  redis.pipeline = plainPipeline;
  is("the other tab is refused while the winning save completes", [middle.status, middle.body.error, winnerAnswer.status, winnerAnswer.body.ok], [409, "stale", 200, true]);
  is("the refusal carries the whole winning save, never its middle", [middle.body.current?.yearly, middle.body.current?.about], [{ cents: 20000 }, "The complete winning description."]);
  const adopted = await save({
    ...form,
    rev: middle.body.current?.rev,
    title: "The losing tab, after adopting",
    yearly: middle.body.current?.yearly ? { price: String(middle.body.current.yearly.cents / 100) } : null,
    about: middle.body.current?.about ?? "",
  });
  const afterAdopting = (await readListing((await storeForEmail(owner))!, id))!;
  is("adopting and saving cannot erase the winner's yearly price or description", [adopted.status, afterAdopting.yearly, await readAbout((await storeForEmail(owner))!.statsId, id)], [200, { cents: 20000 }, "The complete winning description."]);

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
  is("the focus moves once the notice is on the page, from an effect, not a frame asked for before it", /useEffect\(\(\) => \{\s*if \(stale\) document\.getElementById\(`product-\$\{stale\.id\}-stale-title`\)\?\.focus\(\);/.test(editor), true);
  is("both ways forward are offered by name", /Keep my changes and save/.test(editor) && /Use the saved version/.test(editor), true);

  part("A finished save can close only the opening that submitted it");
  // Exercise the production completion callback with an in-memory request that
  // can finish after the creator has canceled or opened another form (Codex L and X4 on #4238).
  const saveSource = /const save = \(\) => \{\n([\s\S]*?)\n              \};\n              return \(\n              <>\n              <ProductForm/.exec(editor)?.[1];
  if (!saveSource) throw new Error("The product form's save callback was not found");
  const saveForm = new Function("product", "aboutFor", "payloadOf", "draft", "aboutUnread", "openedRev", "run", "setEditingId", "setPriceReview", saveSource);
  for (const [label, active, opening, expected] of [
    ["the same opening", "product-a", 1, null],
    ["a different product", "product-b", 2, "product-b"],
    ["the same product reopened", "product-a", 2, "product-a"],
  ] as const) {
    const aboutFor = { current: 1 };
    let finish: (() => void) | undefined;
    let editing: string | null = "product-a";
    let priceReview: string | null = "product-a";
    saveForm(
      { id: "product-a" }, aboutFor, () => ({}), {}, false, 1,
      (_payload: unknown, done: () => void) => { finish = done; },
      (set: (value: string | null) => string | null) => { editing = set(editing); },
      (set: (value: string | null) => string | null) => { priceReview = set(priceReview); },
    );
    if (!finish) throw new Error("The save did not submit a completion callback");
    aboutFor.current = opening;
    editing = active;
    priceReview = active;
    finish();
    is(label, [editing, priceReview], [expected, expected]);
  }

  part("What a refusal reads is counted, in the studio request it is part of");
  is("two reads at most: the listing and the description", PRODUCT_STALE_READ.commands, 2);
  is("bounded by a product's records and the longest description", PRODUCT_STALE_READ.bytes, MAX_PRODUCT_BYTES + MAX_ABOUT_LENGTH * 4);
  const route = readFileSync("app/api/store/product/route.ts", "utf8");
  const refusal = /done\.reason === "stale"\) \{([\s\S]*?)\n      \}/.exec(route)?.[1] ?? "";
  is("the refusal reads only those two, and writes nothing", [(refusal.match(/await /g) ?? []).length, /readListing\(/.test(refusal), /readAbout\(/.test(refusal), /set|write|save/i.test(refusal.replace(/\/\/.*$/gm, ""))], [2, true, true, false]);

  done();
}
void main();
