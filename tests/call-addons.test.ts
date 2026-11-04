/**
 * Add-ons on a booking, the rules (637 [GL5], unit 7a; added 4 November
 * 2026; lib/call-addons.ts): the same rules as a checkout box on a one-off
 * product, read for a call host, with a call's own reasons said by name.
 * Synthetic listings only; nothing is offered, charged or delivered yet.
 */
import { readFileSync } from "node:fs";
import type { Listing } from "@/lib/store";
import { MAX_BUMPS, bumpState } from "@/lib/product-extras";
import {
  type CallAddOnContext,
  type CallAddOnPause,
  activeCallAddOns,
  callAddOnKeepWords,
  callAddOnPauseWords,
  callAddOnRefund,
  callAddOnState,
  callAddOnsClosed,
  callAddOnsTotal,
  chosenCallAddOns,
} from "@/lib/call-addons";
import { done, is, part } from "./check";

const base = { recurring: null, call: null, options: [], pwyw: false, stock: null, bundle: null, pick: false, file: null, link: null, bumps: [] };
const item = (id: string, title: string, priceCents: number, extra: Partial<Record<string, unknown>> = {}) =>
  ({ ...base, id, title, priceCents, file: { name: `${id}.pdf` }, ...extra }) as unknown as Listing;

const workbook = item("wb", "Workbook", 2900);
const recording = item("rec", "Recording", 1500);
const checklist = item("chk", "Checklist", 900);
const membership = item("mem", "Membership", 1900, { recurring: { interval: "month" } });
const limited = item("lim", "Signed print", 4000, { stock: 10 });
const empty = item("emp", "Empty", 900, { file: null });
const coaching = item("call", "Coaching", 12000, {
  file: null,
  call: { kind: "weekly", minutes: 60 },
  bumps: [
    { productId: "wb", priceCents: 1900, pitch: "The workbook we use in the call" },
    { productId: "rec", priceCents: 1500, pitch: "" },
    { productId: "chk", priceCents: 900, pitch: "" },
  ],
});
const products = [workbook, recording, checklist, membership, limited, empty, coaching];
const open: CallAddOnContext = { fromPackage: false, deposit: false, series: false, move: false };

part("Where add-ons are offered at all");
is("on a paid call booked and paid for once", callAddOnsClosed(coaching, open), null);
is(
  "never on a session from a package, a deposit call, a series or a move; each said by name, the move first",
  [
    callAddOnsClosed(coaching, { ...open, fromPackage: true }),
    callAddOnsClosed(coaching, { ...open, deposit: true }),
    callAddOnsClosed(coaching, { ...open, series: true }),
    callAddOnsClosed(coaching, { ...open, move: true, fromPackage: true }),
  ],
  ["package", "deposit", "series", "move"],
);
is(
  "a deposit is read from the call itself too, so a caller that forgets to say it never mixes it with an add-on; an online call never takes one",
  [
    callAddOnsClosed(item("dep", "In person", 12000, { file: null, call: { kind: "weekly", minutes: 60, deposit: 3000, place: { kind: "address" } } }), open),
    callAddOnsClosed(item("onl", "Online", 12000, { file: null, call: { kind: "weekly", minutes: 60, deposit: 3000 } }), open),
  ],
  ["deposit", null],
);
is("a form naming more boxes than a call can hold is read no further", chosenCallAddOns(activeCallAddOns(products, coaching, open), ["x", "y", "z", "q", "wb"]).length, 0);
is(
  "never on a product that is not a paid call: a one-off product keeps its own boxes (lib/product-extras.ts), a free call, one with buyers' own price or several prices",
  [workbook, { ...coaching, priceCents: 0 }, { ...coaching, pwyw: true }, { ...coaching, options: [{ id: "o1" }] }, { ...coaching, recurring: { interval: "month" } }].map((p) => callAddOnsClosed(p as Listing, open)),
  ["notCall", "notCall", "notCall", "notCall", "notCall"],
);

part("What can be added: the same rules as a checkout box");
is("the creator's three, in their order", activeCallAddOns(products, coaching, open).map((a) => a.target.title), ["Workbook", "Recording", "Checklist"]);
const at = (productId: string, priceCents = 500) => callAddOnState(products, coaching, { productId, priceCents, pitch: "" }, open);
is(
  "never something gone, the call itself, a membership, a limited one, or one with nothing to hand over",
  [at("nope"), at("call"), at("mem"), at("lim"), at("emp")].map((s) => ("paused" in s ? s.paused : "offered")),
  ["gone", "itself", "targetRecurring", "targetLimited", "targetEmpty"],
);
is("never dearer than buying it on its own", "paused" in at("chk", 1000) ? at("chk", 1000) : null, { paused: "dearer", bump: { productId: "chk", priceCents: 1000, pitch: "" } });
is(
  "the target's reasons are exactly a checkout box's: a box on a one-off product with the same target is paused for the same reason",
  ["mem", "lim", "emp", "nope"].map((id) => {
    const host = { ...workbook, id: "host", bumps: [] } as Listing;
    const box = bumpState(products, host, { productId: id, priceCents: 500, pitch: "" });
    const call = at(id);
    return ("paused" in box ? box.paused : "") === ("paused" in call ? call.paused : "");
  }),
  [true, true, true, true],
);
const many = { ...coaching, bumps: [...coaching.bumps, { productId: "wb", priceCents: 100, pitch: "" }] } as Listing;
is("at most as many as a checkout offers", [activeCallAddOns(products, many, open).length, MAX_BUMPS], [3, 3]);
is("none at all where the booking takes none", [activeCallAddOns(products, coaching, { ...open, deposit: true }).length, activeCallAddOns(products, coaching, { ...open, move: true }).length], [0, 0]);

part("What the buyer checked");
const active = activeCallAddOns(products, coaching, open);
is("nothing checked is nothing added: a box is never checked for the buyer", [chosenCallAddOns(active, undefined), chosenCallAddOns(active, []), chosenCallAddOns(active, null)], [[], [], []]);
is(
  "what is checked, each once, at the add-on's price from the creator's record, in the creator's order",
  chosenCallAddOns(active, ["chk", "wb", "wb", " chk "]),
  [{ productId: "wb", title: "Workbook", cents: 1900 }, { productId: "chk", title: "Checklist", cents: 900 }],
);
is("one box sent alone, as a form sends it", chosenCallAddOns(active, "rec"), [{ productId: "rec", title: "Recording", cents: 1500 }]);
is("a product the form names that is not on offer adds nothing, nor does anything but text", [chosenCallAddOns(active, ["mem", "lim", "call"]), chosenCallAddOns(active, [{ productId: "wb" }, 7])], [[], []]);
is("what they add to the price", callAddOnsTotal(chosenCallAddOns(active, ["wb", "rec", "chk"])), 4300);

part("When a booking with add-ons ends before it takes place");
const H = 3_600_000;
const start = Date.UTC(2026, 11, 10, 15);
is(
  "the buyer cancels on time: only the call is refunded; the add-on was delivered with their consent",
  [callAddOnRefund("buyer", { hours: 48, late: false }, start, start - 48 * H), callAddOnRefund("buyer", { hours: 48, late: false }, start, start - 72 * H)],
  ["call", "call"],
);
is(
  "the buyer cancels 1 ms inside the deadline, booked inside it, or on a call with no deadline: nothing is refunded",
  [callAddOnRefund("buyer", { hours: 48, late: false }, start, start - 48 * H + 1), callAddOnRefund("buyer", { hours: 48, late: false }, start, start - 1 * H), callAddOnRefund("buyer", { hours: 48, late: true }, start, start - 72 * H), callAddOnRefund("buyer", null, start, start - 72 * H), callAddOnRefund("buyer", { hours: 48, late: false }, NaN, start)],
  ["nothing", "nothing", "nothing", "nothing", "nothing"],
);
is(
  "the creator cancels, or the store could not hold the time: the add-ons are refunded too, whatever the deadline",
  [callAddOnRefund("creator", null, start, start - H), callAddOnRefund("store", { hours: 48, late: true }, start, start - H)],
  ["callAndAddOns", "callAndAddOns"],
);
const timely = callAddOnKeepWords({ hours: 24, late: false }, "Lena");
const late = callAddOnKeepWords({ hours: 24, late: true }, "Lena");
const none = callAddOnKeepWords(null, "Lena");
is(
  "with the creator's deadline, before it: the call refunded only if canceled in time, and the extra kept",
  [timely.includes("Cancel the call at least 24 hours before it starts to get the call's price back. You keep the extra."), callAddOnKeepWords({ hours: 2, late: false }, "Lena").includes("at least 2 hours before")],
  [true, true],
);
is(
  "booked already inside the deadline: as cancelTooLate says it, the store does not have to refund, and the law's rights stand",
  [late.includes("If you cancel now, Lena does not have to refund the call."), late.includes("This does not affect your rights under the law."), late.includes("price back"), late.includes("gets no refund")],
  [true, true, false, false],
);
is("a call without a deadline promises no refund: canceling is asked of the creator", [none.includes("ask Lena"), /to get it refunded|call refunded/.test(none)], [true, false]);
is("in every case, the creator canceling refunds the extra too", [timely, late, none].every((w) => w.endsWith("If Lena cancels the call, you get the extra refunded too.")), true);
is("in plain words: every sentence under twenty words", [timely, late, none].every((w) => w.split(/(?<=[.!?])\s/).every((sentence) => sentence.split(/\s+/).length <= 20)), true);

part("What the creator is told");
const pauses: CallAddOnPause[] = ["notCall", "package", "deposit", "series", "move", "gone", "itself", "targetFree", "targetRecurring", "targetCall", "targetOptions", "targetPwyw", "targetLimited", "targetEmpty", "targetPick", "dearer"];
is("every reason has its own sentence, never empty, never the same as another", new Set(pauses.map((p) => callAddOnPauseWords(p, "Workbook"))).size, pauses.length);
is(
  "the ones about another product name it, and say what to change",
  ["targetFree", "targetOptions", "dearer"].map((p) => {
    const words = callAddOnPauseWords(p as CallAddOnPause, "Workbook");
    return words.includes('"Workbook"') && /(Give|Lower|Pick|Remove|Add)/.test(words);
  }),
  [true, true, true],
);
is("without its name, still a sentence", callAddOnPauseWords("targetFree", null).startsWith("That product is free now"), true);

part("Nothing is offered yet");
const source = readFileSync("lib/call-addons.ts", "utf8");
is("rules only: no network, no storage, no checkout", /fetch\(|redis|stripe\(|createCheckout/i.test(source.replace(/\/\*\*[\s\S]*?\*\//g, "")), false);
is("one-off products keep their own boxes unchanged", readFileSync("lib/product-extras.ts", "utf8").includes("return product.priceCents > 0 && product.recurring === null && product.call === null;"), true);

done();
