/**
 * Price options, as widened on 7 October 2026: fifty on one product, a course
 * or podcast at several prices, what each one includes, and the creator's pick.
 *
 * What is checked:
 *
 *   - what each option includes is read back trimmed, bounded and without
 *     blank lines, and only one option per product can be the pick;
 *   - the page opens on the pick, or on the first when there is none;
 *   - a fourth option, and many more, can be added; past the published
 *     number one is refused with the number;
 *   - a course takes several prices and every one of them is offered, with
 *     or without a file of its own; a membership course still takes one;
 *   - picking one option un-picks the other, and an edit that does not send
 *     the details keeps them.
 */
import {
  addOption,
  addProduct,
  claimHandle,
  editOption,
  ensureStatsId,
  removeOption,
  setProductCourse,
  setProductLink,
  setStripeAccount,
  setSubscription,
  storeForEmail,
} from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import {
  MAX_OPTIONS,
  MAX_OPTION_DETAILS,
  MAX_OPTION_DETAIL_LENGTH,
  comparable,
  handsOver,
  parseDetails,
  parseOptions,
  optionsInPickOrder,
} from "@/lib/product-option";
import { canSellProduct, sellableOptions } from "@/lib/store-checkout";
import { optionRemovalWords } from "@/lib/price-review";
import { formatMoney } from "@/lib/money";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "options@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_options_only_a_stand_in";

  part("What an option includes");
  is(
    "trimmed, blanks dropped, spaces folded",
    parseDetails("  Everything in 1 week \n\n\nA   shopping list\n"),
    ["Everything in 1 week", "A shopping list"],
  );
  is("bounded in number", parseDetails(Array.from({ length: 20 }, (_, i) => `Line ${i}`)).length, MAX_OPTION_DETAILS);
  is("bounded in length", parseDetails(["x".repeat(500)])[0].length, MAX_OPTION_DETAIL_LENGTH);
  is("nothing for something that is not text", parseDetails(42), []);

  part("Reading options back");
  const read = parseOptions([
    { id: "a", label: "One", priceCents: 100, best: true, details: ["Lesson 1"] },
    { id: "b", label: "Two", priceCents: 200, best: true },
    { id: "c", label: "Three", priceCents: 300 },
  ]);
  is("only the first pick counts", read.map((o) => o.best), [true, false, false]);
  is("an old option has no details", read[2].details, []);
  // Changed by 487 [IT4] (C1-20261106-0100-TODOS-1, rule 23): the pick is listed first and no longer opens chosen.
  is("the pick is listed first", optionsInPickOrder(read)[0]?.id, "a");
  is("with no pick, the creator's order", optionsInPickOrder(read.map((o) => ({ ...o, best: false }))).map((o) => o.id), ["a", "b", "c"]);
  is("compared once something is listed", comparable(read), true);
  is("not compared when nothing is", comparable(read.map((o) => ({ ...o, details: [] }))), false);

  await claimHandle(OWNER, "optionsshop", "Options Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_fixture011", true);
  await setSubscription(OWNER, { customerId: "cus_Options0001", subscriptionId: "sub_Options0001", active: true, period: paidPeriod() });

  part("Many prices on one product");
  const made = await addProduct(OWNER, "Template pack", "", "19", null);
  if (!made.ok) throw new Error("no product");
  for (let i = 1; i <= 4; i += 1) {
    const added = await addOption(OWNER, made.product.id, `${i} seats`, String(10 * i));
    is(`option ${i} added`, added.ok, true);
  }
  let store = (await storeForEmail(OWNER))!;
  is("a fourth option is kept", (await readProduct(store, made.product.id))!.options.length, 4);
  for (let i = 5; i <= MAX_OPTIONS; i += 1) await addOption(OWNER, made.product.id, `${i} seats`, String(10 * i));
  const over = await addOption(OWNER, made.product.id, "One too many", "999");
  is("past the published number, refused with it", over.ok ? "added" : [over.reason, over.limit], ["too_many", MAX_OPTIONS]);

  part("A course at several prices");
  const course = await addProduct(OWNER, "Sourdough course", "", "49", null);
  if (!course.ok) throw new Error("no course");
  await setProductCourse(OWNER, course.product.id, { id: "c".repeat(32), lessons: 3 });
  const alone = await addOption(OWNER, course.product.id, "The course", "49", { details: "All 12 lessons" });
  const withQa = await addOption(OWNER, course.product.id, "With live Q&A", "89", { details: "All 12 lessons\nA live Q&A each month", best: true });
  is("both added", [alone.ok, withQa.ok], [true, true]);
  store = (await storeForEmail(OWNER))!;
  let sold = (await readProduct(store, course.product.id))!;
  is("every price is offered, with no file of its own", sellableOptions(sold).map((o) => o.label), ["The course", "With live Q&A"]);
  is("and the course can be sold", canSellProduct(store, sold), true);
  // Changed by 487 [IT4] (rule 23): the marked pick is listed first, not chosen for the buyer.
  is("the pick is the one marked, listed first", optionsInPickOrder(sellableOptions(sold))[0]?.label, "With live Q&A");

  part("Choosing the pick");
  const first = sold.options[0];
  await editOption(OWNER, first.id, first.label, "49", { best: true });
  store = (await storeForEmail(OWNER))!;
  sold = (await readProduct(store, course.product.id))!;
  is("picking one un-picks the other", sold.options.map((o) => o.best), [true, false]);
  await editOption(OWNER, first.id, "Course only", "49");
  store = (await storeForEmail(OWNER))!;
  sold = (await readProduct(store, course.product.id))!;
  is("an edit without details keeps them", [sold.options[0].label, sold.options[0].details], ["Course only", ["All 12 lessons"]]);

  part("Removing the only price that hands anything over");
  // A digital product with no file of its own: "Basic" has a link, "Pro" has nothing yet.
  const brushes = await addProduct(OWNER, "Brush set", "", "15", null);
  if (!brushes.ok) throw new Error("no brush set");
  await addOption(OWNER, brushes.product.id, "Basic", "15");
  await addOption(OWNER, brushes.product.id, "Pro", "25");
  store = (await storeForEmail(OWNER))!;
  const basicId = (await readProduct(store, brushes.product.id))!.options[0].id;
  await setProductLink(OWNER, basicId, "https://example.com/brushes-basic");
  store = (await storeForEmail(OWNER))!;
  const brushSet = (await readProduct(store, brushes.product.id))!;
  const withoutBasic = { ...brushSet, options: brushSet.options.filter((o) => o.id !== basicId) };
  is("sold through Basic's link; the studio's rule reads the same", [canSellProduct(store, brushSet), handsOver(brushSet)], [true, true]);
  is("without Basic, Pro is offered to nobody and the checkout refuses it; the studio's rule reads the same", [sellableOptions(withoutBasic).length, canSellProduct(store, withoutBasic), handsOver(withoutBasic)], [0, false, false]);
  const said = optionRemovalWords(
    { hasFile: false, delivers: true, extra: false },
    { options: brushSet.options.length, interval: null, hidden: false, ownPriceCents: brushSet.priceCents, missing: null, ownDelivery: false, sellsBefore: handsOver(brushSet), sellsAfter: handsOver(withoutBasic), payments: 0, introKept: false, yearlyKept: false, planBefore: false, planAfter: false },
    (cents) => formatMoney(cents, "usd"),
  );
  is("removing Basic, with Pro still there, says it cannot be bought", said, "Anyone who bought at it can no longer get its file or link from their order. No other price hands anything over, so this cannot be bought until one has a file or link.");
  const gone = await removeOption(OWNER, basicId);
  store = (await storeForEmail(OWNER))!;
  is("and once removed, it really cannot be bought", [gone.ok, canSellProduct(store, (await readProduct(store, brushes.product.id))!)], [true, false]);

  part("A course sold as a membership");
  const club = await addProduct(OWNER, "Bread club", "", "9", { interval: "month", payments: 0, trialDays: 0 });
  if (!club.ok) throw new Error("no membership");
  await setProductCourse(OWNER, club.product.id, { id: "d".repeat(32), lessons: 1 });
  const refused = await addOption(OWNER, club.product.id, "Yearly", "90");
  is("still at one price", refused.ok ? "added" : refused.reason, "course");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
