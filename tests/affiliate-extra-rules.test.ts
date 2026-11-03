/**
 * An extra from the creator for buying through one affiliate's link
 * (630 [HN6](6), unit 1: lib/affiliate-extra-rules.ts, and its place in
 * lib/bundle-rules.ts deliveredIds).
 */
import {
  MAX_EXTRAS,
  MAX_EXTRA_OFFERS,
  extraFromMeta,
  extraMeta,
  extraProblem,
  extraWords,
  extrasAllowed,
  extrasFor,
  readExtraOffers,
} from "@/lib/affiliate-extra-rules";
import { deliveredIds } from "@/lib/bundle-rules";
import type { Listing } from "@/lib/store";
import { done, is, part } from "./check";

type L = Listing;
const listing = (id: string, over: Partial<L> = {}) =>
  ({ id, title: `Guide ${id}`, priceCents: 2_700, recurring: null, call: null, bundle: null, options: [], pwyw: null, course: null, file: { name: "a.pdf" }, link: null, stock: null, ...over }) as unknown as L;
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";
const shelf = [
  listing("guide1"),
  listing("guide2"),
  listing("guide3"),
  listing("guide4"),
  listing("linked", { file: null, link: { url: "https://example.com" } as unknown as L["link"] }),
  listing("course1", { file: null, course: { lessons: 4 } as unknown as L["course"] }),
  listing("draft", { hidden: true } as unknown as Partial<L>),
  listing("member", { recurring: { interval: "month" } as unknown as L["recurring"] }),
  listing("call1", { call: {} as unknown as L["call"] }),
  listing("free1", { priceCents: 0 }),
  listing("few", { stock: 10 }),
  listing("empty", { file: null }),
  listing("several", { options: [{ id: "a" }] as unknown as L["options"] }),
  listing("choose", { pwyw: { min: 100 } as unknown as L["pwyw"] }),
  listing("pack", { bundle: ["guide1", "guide2"] as unknown as L["bundle"] }),
  listing("nolessons", { file: null, course: { lessons: 0 } as unknown as L["course"] }),
];
const ids = (list: L[]) => list.map((l) => l.id);
const ana = { id: ANA, status: "approved" };
const paid = { meta: { product: "guide1" }, amountCents: 2_700 };

part("The offers as kept");
is("nothing kept: none", readExtraOffers(undefined), []);
is("not a list: none", readExtraOffers({ aff: ANA }), []);
is("kept as written when it is sound", readExtraOffers([{ aff: ANA, items: ["guide1", "guide2"] }]), [{ aff: ANA, items: ["guide1", "guide2"] }]);
is(
  "an affiliate id that is not one, an empty list and a repeat of the same affiliate are dropped",
  readExtraOffers([{ aff: "x", items: ["guide1"] }, { aff: BEN, items: [] }, { aff: ANA, items: ["guide1"] }, { aff: ANA, items: ["guide2"] }]),
  [{ aff: ANA, items: ["guide1"] }],
);
is(
  "a list is deduplicated, cleaned and capped",
  readExtraOffers([{ aff: ANA, items: ["guide1", "guide1", "<b>", 7, "guide2", "guide3", "guide4"] }])[0].items,
  ["guide1", "guide2", "guide3"],
);
const many = Array.from({ length: MAX_EXTRA_OFFERS + 10 }, (_, i) => ({ aff: i.toString(36).padStart(12, "a"), items: ["guide1"] }));
is("never more offers than the cap", readExtraOffers(many).length, MAX_EXTRA_OFFERS);

part("What the studio may save");
const approved = [ANA, BEN];
is("one to three of the store's whole products, for an approved affiliate: fine", extraProblem({ aff: ANA, items: ["guide1", "guide2", "guide3"] }, shelf, [], approved), null);
for (const id of ["linked", "course1", "draft"]) {
  is(`${id}: may be an extra, as it may be in a bundle`, extraProblem({ aff: ANA, items: [id] }, shelf, [], approved), null);
}
is("not an affiliate id", extraProblem({ aff: "nobody", items: ["guide1"] }, shelf, [], approved), "affiliate");
is("an affiliate the creator does not approve today", extraProblem({ aff: "cccccccccccc", items: ["guide1"] }, shelf, [], approved), "affiliate");
is("none", extraProblem({ aff: ANA, items: [] }, shelf, [], approved), "count");
is(`more than ${MAX_EXTRAS}`, extraProblem({ aff: ANA, items: ["guide1", "guide2", "guide3", "guide4"] }, shelf, [], approved), "count");
is("the same product twice", extraProblem({ aff: ANA, items: ["guide1", "guide1"] }, shelf, [], approved), "count");
is("not a list", extraProblem({ aff: ANA, items: "guide1" }, shelf, [], approved), "count");
is("a product the store does not have", extraProblem({ aff: ANA, items: ["ghost"] }, shelf, [], approved), "unknown");
is("an id that is not text", extraProblem({ aff: ANA, items: [7] }, shelf, [], approved), "unknown");
for (const id of ["member", "call1", "free1", "empty", "several", "choose", "pack", "nolessons"]) {
  is(`${id}: cannot be handed over whole`, extraProblem({ aff: ANA, items: [id] }, shelf, [], approved), "kind");
}
is("a product with a limited number", extraProblem({ aff: ANA, items: ["few"] }, shelf, [], approved), "stock");
const full = many.slice(0, MAX_EXTRA_OFFERS);
is("one offer too many", extraProblem({ aff: "zzzzzzzzzzzz", items: ["guide1"] }, shelf, full, ["zzzzzzzzzzzz"]), "too_many");
is("changing an affiliate's own offer is not one more", extraProblem({ aff: full[0].aff, items: ["guide2"] }, shelf, full, [full[0].aff]), null);

part("Which orders may carry an extra");
is("a paid purchase for oneself", extrasAllowed(paid), true);
for (const [what, meta] of [
  ["a gift", { gift: "1" }],
  ["a purchase for several people", { group: "3" }],
  ["a pre-order", { preorder: "1" }],
  ["a tip", { kind: "tip" }],
  ["a payment request", { kind: "request" }],
] as const) {
  is(`${what}: never`, extrasAllowed({ meta, amountCents: 2_700 }), false);
}
is("an order that charged nothing: never", extrasAllowed({ meta: {}, amountCents: 0 }), false);
is("an amount that is not a number: never", extrasAllowed({ meta: {}, amountCents: Number.NaN }), false);

part("What an order gains");
const offers = readExtraOffers([{ aff: ANA, items: ["guide2", "guide3", "few"] }]);
is("through Ana's link: her offer", ids(extrasFor(offers, ana, "click", paid, ["guide1"], shelf)), ["guide2", "guide3"]);
is("never what the order already hands over", ids(extrasFor(offers, ana, "click", paid, ["guide1", "guide2"], shelf)), ["guide3"]);
is("buying the extra itself: it is not added again", ids(extrasFor(offers, ana, "click", paid, ["guide3"], shelf)), ["guide2"]);
is("through Ben's link: nothing, he has no offer", ids(extrasFor(offers, { id: BEN, status: "approved" }, "click", paid, ["guide1"], shelf)), []);
for (const status of ["pending", "declined", "removed"]) {
  is(`Ana ${status} since: nothing added`, ids(extrasFor(offers, { id: ANA, status }, "click", paid, ["guide1"], shelf)), []);
}
is("no affiliate: nothing", ids(extrasFor(offers, null, "click", paid, ["guide1"], shelf)), []);
is("an affiliate id that is not one: nothing", ids(extrasFor(offers, { id: "x", status: "approved" }, "click", paid, ["guide1"], shelf)), []);
for (const how of ["code", "buyer", "contact", "recurring", ""]) {
  is(`credited by ${how || "nothing"}: nothing added, the line was shown to whoever followed the link`, ids(extrasFor(offers, ana, how, paid, ["guide1"], shelf)), []);
}
is("a gift through her link: nothing added", ids(extrasFor(offers, ana, "click", { meta: { gift: "1" }, amountCents: 2_700 }, [], shelf)), []);
is("an order that charged nothing: nothing added", ids(extrasFor(offers, ana, "click", { meta: {}, amountCents: 0 }, ["guide1"], shelf)), []);
const changed = shelf.map((l) => (l.id === "guide3" ? listing("guide3", { stock: 5 }) : l.id === "guide2" ? listing("guide2", { file: null }) : l));
is("an extra changed since it was chosen is not handed over", ids(extrasFor(offers, ana, "click", paid, ["guide1"], changed)), []);
is("an extra deleted since: not handed over", ids(extrasFor(offers, ana, "click", paid, ["guide1"], shelf.filter((l) => l.id !== "guide2"))), ["guide3"]);

part("On the checkout, and handed over with the order");
const meta = extraMeta([shelf[1], shelf[2]]);
is("written under one key", meta, { aff_extra: "guide2,guide3" });
is("read back as written", extraFromMeta(meta), ["guide2", "guide3"]);
is("written once each", extraMeta([shelf[1], shelf[1], shelf[2]]), { aff_extra: "guide2,guide3" });
is("none: no key at all", extraMeta([]), {});
is("a key tampered with is cleaned and capped", extraFromMeta({ aff_extra: "guide1,<x>,guide1,guide2,guide3,guide4" }), ["guide1", "guide2", "guide3"]);
is("no key: none", extraFromMeta({}), []);
is("within Stripe's limit at the most", extraMeta(Array.from({ length: 9 }, (_, i) => ({ id: `${i}${"x".repeat(63)}` }))).aff_extra.length <= 500, true);
is("the order hands the extras over with the product bought", deliveredIds({ product: "guide1", aff_extra: "guide2,guide3" }), ["guide1", "guide2", "guide3"]);
is("each once, even when the product bought is one of them", deliveredIds({ product: "guide2", aff_extra: "guide2,guide3" }), ["guide2", "guide3"]);
is("a gift hands nothing to whoever paid, extras included", deliveredIds({ product: "guide1", gift: "1", aff_extra: "guide2" }), []);
is("an order with none: as before", deliveredIds({ product: "guide1" }), ["guide1"]);

part("Said before the purchase, plainly");
is("one", extraWords("Harbor Kitchen", ["Bread basics"]), "With this order, Harbor Kitchen also includes: Bread basics.");
is("two", extraWords("Harbor Kitchen", ["A", "B"]), "With this order, Harbor Kitchen also includes: A and B.");
is("three, with the serial comma", extraWords("Harbor Kitchen", ["A", "B", "C"]), "With this order, Harbor Kitchen also includes: A, B, and C.");
is("nothing to say: nothing shown", extraWords("Harbor Kitchen", ["  "]), "");
is("no store name: nothing shown", extraWords("  ", ["A"]), "");
const words = extraWords("Harbor Kitchen", ["A"]);
is("no price, no 'free', no urgency", /\$|free|today|now|only|limited|hurry|gives? you/i.test(words), false);

done();
