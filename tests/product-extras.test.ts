/**
 * What stops being shown when a creator changes a different product.
 *
 * The defect these were written for: lowering one product's price silently
 * killed every checkout box and after-paying offer that charged more for it
 * than it now cost, and raising a price silently killed the payment plan that
 * used to cover it. None of that was wrong — a box dearer than the product is
 * not a box to show — but the studio went on saying "Offers Templates for $9 at
 * checkout" and "Payment plan: 3 monthly payments of $110" through all of it.
 * The only way to find out was to notice the money missing.
 *
 * So what is checked here is that the rule and the reason cannot drift apart:
 * `activeBumps` and `bumpState` are one set of rules, and every way an extra can
 * go quiet has a sentence naming the product to change.
 */
import {
  type BumpPause,
  type PlanPause,
  activeBumps,
  activePlan,
  bumpPauseWords,
  bumpState,
  planPauseWords,
  planState,
} from "@/lib/product-extras";
import { activeFunnel, funnelHealth, stepPauseWords } from "@/lib/funnel";
import { quietedBy } from "@/lib/extras-notes";
import type { Listing, Product } from "@/lib/store";
import { done, is, part } from "./check";

/** A plain one-off product with a file behind it: the ordinary case. */
function item(id: string, priceCents: number, over: Partial<Product> = {}): Product {
  return {
    id,
    title: id === "front" ? "Front Offer" : id === "addon" ? "Templates" : id,
    summary: "",
    priceCents,
    recurring: null,
    call: null,
    course: null,
    options: [],
    pwyw: null,
    stock: null,
    bundle: null,
    file: { pathname: `${id}.pdf`, name: `${id}.pdf`, size: 1, url: "" },
    link: null,
    bumps: [],
    plan: null,
    funnel: null,
    fields: [],
    image: null,
    hidden: false,
    about: false,
    page: false,
    keys: null,
    ...over,
  } as unknown as Product;
}

const box = (productId: string, priceCents: number) => ({ productId, priceCents, pitch: "" });

/** The reason a box is quiet, or "shown". */
function why(products: Listing[], product: Listing): BumpPause | "shown" | "none" {
  if (!product.bumps[0]) return "none";
  const state = bumpState(products, product, product.bumps[0]);
  return "paused" in state ? state.paused : "shown";
}

part("A checkout box, and why it is not being shown");
{
  const addon = item("addon", 9_700);
  const front = item("front", 700, { bumps: [box("addon", 2_900)] });
  const all = [front, addon];

  is("cheaper than on its own: shown", why(all, front), "shown");
  is("and activeBumps agrees", activeBumps(all, front).length, 1);

  // The defect itself: a price cut on the *other* product.
  const cut = [front, item("addon", 1_900)];
  is("the offered product now costs less than the box charges", why(cut, front), "dearer");
  is("and activeBumps agrees", activeBumps(cut, front), []);
  is(
    "the sentence names the product to change",
    bumpPauseWords("dearer", "Templates"),
    "The box charges more for Templates than buying it on its own does. Lower the box's price, or raise the price of Templates.",
  );
  is(
    "the same reason, worded for an offer after paying",
    stepPauseWords("dearer", "Templates"),
    "This offer charges more for Templates than buying it on its own does. Lower this offer's price, or raise the price of Templates.",
  );

  is("the same price is still fine", why([front, item("addon", 2_900)], front), "shown");
  is("gone from the store", why([front], front), "gone");
  is("pointing at itself", why([item("front", 700, { bumps: [box("front", 500)] })], item("front", 700, { bumps: [box("front", 500)] })), "itself");
  is("the offered product charged monthly", why([front, item("addon", 9_700, { recurring: { interval: "month", trialDays: 0, payments: 0 } })], front), "targetRecurring");
  is("the offered product given away", why([front, item("addon", 0)], front), "targetFree");
  is("the offered product turned into a booking", why([front, item("addon", 9_700, { call: {} as unknown as Product["call"] })], front), "targetCall");
  is("the offered product with several prices", why([front, item("addon", 9_700, { options: [{ id: "a", label: "A", priceCents: 9_700, file: null, link: null, details: [], best: false }] })], front), "targetOptions");
  is("buyers name the price on the offered product", why([front, item("addon", 9_700, { pwyw: { suggestedCents: 9_700 } })], front), "targetPwyw");
  is("a limited number of the offered product", why([front, item("addon", 9_700, { stock: 20 })], front), "targetLimited");
  is("nothing behind the offered product", why([front, item("addon", 9_700, { file: null })], front), "targetEmpty");
  is("the offered product is a draft (MM-SA-33)", why([front, item("addon", 9_700, { hidden: true })], front), "targetDraft");
  is("this product charged monthly", why(all, item("front", 700, { bumps: [box("addon", 2_900)], recurring: { interval: "month", trialDays: 0, payments: 0 } })), "kind");
  is("buyers name the price here", why(all, item("front", 700, { bumps: [box("addon", 2_900)], pwyw: { suggestedCents: 700 } })), "pwyw");
  is("no box set up at all", why(all, item("front", 700)), "none");

  // Every reason has a sentence, and none of them is empty or a placeholder.
  const every: BumpPause[] = [
    "kind", "pwyw", "gone", "itself", "targetDraft", "targetFree", "targetRecurring", "targetCall",
    "targetOptions", "targetPwyw", "targetLimited", "targetEmpty", "dearer",
  ];
  is(
    "every reason has its own sentence",
    // Each one a whole sentence of its own: a capital letter, a full stop, and
    // no leading label, because the place it appears already says what it is.
    every.filter((r) => !/^[A-Z].*\.$/.test(bumpPauseWords(r, "Templates"))).length,
    0,
  );
  is(
    "and every sentence is different",
    new Set(every.map((r) => bumpPauseWords(r, "Templates"))).size,
    every.length,
  );
}

part("A payment plan, and why it is not being offered");
{
  const plan = { payments: 3, interval: "month" as const, amountCents: 11_000 };
  const covered = item("front", 33_000, { plan });
  is("the payments cover the price: offered", planState(covered) && !("paused" in planState(covered)!), true);
  is("and activePlan agrees", activePlan(covered), plan);

  // The defect: the price went up and the plan quietly stopped.
  const raised = item("front", 40_000, { plan });
  is("the price outgrew the plan", (planState(raised) as { paused: PlanPause }).paused, "short");
  is("and activePlan agrees", activePlan(raised), null);
  is(
    "the sentence does the arithmetic for the creator",
    planPauseWords("short", plan, raised, "usd"),
    "3 payments of $110 come to $330, less than the $400 price. Raise each payment, add one, or lower the price.",
  );

  is("several prices", (planState(item("front", 33_000, { plan, options: [{ id: "a", label: "A", priceCents: 1, file: null, link: null, details: [], best: false }] })) as { paused: PlanPause }).paused, "options");
  is("buyers name the price", (planState(item("front", 33_000, { plan, pwyw: { suggestedCents: 1 } })) as { paused: PlanPause }).paused, "pwyw");
  is("charged monthly", (planState(item("front", 33_000, { plan, recurring: { interval: "month", trialDays: 0, payments: 0 } })) as { paused: PlanPause }).paused, "kind");
  is("no plan set up at all", planState(item("front", 33_000)), null);
}

part("Offers after paying");
{
  const step = (productId: string, priceCents: number) => ({
    id: productId,
    productId,
    priceCents,
    headline: "",
    text: "",
    imageFrom: null,
    yes: null,
    no: null,
  });
  const funnel = { steps: [step("addon", 2_900), step("extra", 4_900)] };
  const front = item("front", 700, { funnel });
  const all = [front, item("addon", 9_700), item("extra", 9_700)];

  is("both offers showable", funnelHealth(all, front), { shown: 2, dark: [], off: null });
  is("and the funnel follows the sale", activeFunnel(all, front) !== null, true);

  // One product's price cut takes one offer out, and the funnel goes on.
  const oneCut = [front, item("addon", 1_900), item("extra", 9_700)];
  const health = funnelHealth(oneCut, front)!;
  is("one offer dark, one still shown", { shown: health.shown, dark: health.dark.length, off: health.off }, { shown: 1, dark: 1, off: null });
  is("and the funnel still follows the sale", activeFunnel(oneCut, front) !== null, true);
  is("the dark one is named", health.dark[0].step.productId, "addon");

  // Both cut, and nothing follows the sale at all.
  const bothCut = [front, item("addon", 1_900), item("extra", 1_900)];
  is("nothing left to show", funnelHealth(bothCut, front)!.off, "none");
  is("and the funnel no longer follows the sale", activeFunnel(bothCut, front), null);

  is(
    "an offer priced under the smallest charge says so",
    stepPauseWords("tooLittle", "Templates"),
    "The price of this offer is below the smallest amount a card can be charged. Raise it.",
  );
}

part("What a save tells the creator it silenced");
{
  const bumped = item("front", 700, { bumps: [box("addon", 2_900)] });
  const cheaper = item("addon", 1_900);
  is(
    "the price cut names the product that lost its box",
    quietedBy("addon", [bumped, cheaper], [bumped, cheaper], "usd"),
    ["Front Offer: The box charges more for Templates than buying it on its own does. Lower the box's price, or raise the price of Templates."],
  );
  is(
    "nothing to say when nothing went quiet",
    quietedBy("addon", [bumped, item("addon", 9_700)], [bumped, item("addon", 9_700)], "usd"),
    [],
  );
  is(
    "a product taken out of the store is named too",
    quietedBy("addon", [bumped], [bumped], "usd"),
    ["Front Offer: The product the box offered is no longer in your store. Pick another one."],
  );
  const outgrown = item("front", 40_000, { plan: { payments: 3, interval: "month", amountCents: 11_000 } });
  is(
    "a raised price names its own plan",
    quietedBy("front", [outgrown], [outgrown], "usd"),
    ["Front Offer: 3 payments of $110 come to $330, less than the $400 price. Raise each payment, add one, or lower the price."],
  );
}

done();
