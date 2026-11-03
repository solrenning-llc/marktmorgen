/**
 * 630 [HN6](2), unit 1: notice before an affiliate's terms get worse
 * (lib/affiliate-notice.ts). A cut to the share, a product's share or the
 * window waits the notice; a raise applies at once; the old terms hold
 * until the day and the new ones from it; a product taken out of the program
 * is a cut too; a saved change restarts only what still gets worse; nothing
 * waits without a notice; stored values are read only whole.
 */
import { MAX_NOTICE_DAYS, MIN_NOTICE_DAYS, lowers, noticeLines, planTerms, readNoticeDays, readPending, termsAt } from "@/lib/affiliate-notice";
import { commissionRate, NO_AFFILIATES } from "@/lib/affiliate-setting";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = 1_800_000_000;
const PRODUCT = "prod000001";
const OTHER = "prod000002";
const base = { percent: 30, rates: { [PRODUCT]: 40 }, days: 60 };

part("The notice a creator may give");
is("3 to 90 days", [MIN_NOTICE_DAYS, MAX_NOTICE_DAYS], [3, 90]);
is("inside the bounds: kept", [readNoticeDays(3), readNoticeDays("30"), readNoticeDays(90)], [3, 30, 90]);
is("outside them, or not a whole number: none", [readNoticeDays(2), readNoticeDays(91), readNoticeDays(7.5), readNoticeDays("x"), readNoticeDays(null)], [0, 0, 0, 0, 0]);

part("What counts as worse for an affiliate");
is("a lower share", lowers(base, { ...base, percent: 20 }), true);
is("a shorter window", lowers(base, { ...base, days: 30 }), true);
is("a lower share on one product", lowers(base, { ...base, rates: { [PRODUCT]: 35 } }), true);
is("a product taken out (0%)", lowers(base, { ...base, rates: { [PRODUCT]: 0 } }), true);
is("a product's own share removed, falling to a lower store share", lowers(base, { ...base, rates: {} }), true);
is("a higher share, a longer window, a new product share above the store's: not worse", lowers(base, { percent: 35, rates: { [PRODUCT]: 45, [OTHER]: 50 }, days: 90 }), false);

part("A cut waits the notice; the old terms hold until the day");
const cut = planTerms(base, { ...base, percent: 20, days: 30 }, 30, NOW);
is("today: the old share and window", [cut.current.percent, cut.current.days], [30, 60]);
is("the new terms wait thirty days", cut.pending ? [cut.pending.percent, cut.pending.days, cut.pending.from] : null, [20, 30, NOW + 30 * DAY]);
is("a sale the day before: old terms", termsAt(cut.current, cut.pending, NOW + 30 * DAY - 1).percent, 30);
is("a sale on the day: new terms", termsAt(cut.current, cut.pending, NOW + 30 * DAY).percent, 20);
is("a product's own share is untouched by a store-wide cut", commissionRate({ ...NO_AFFILIATES, ...termsAt(cut.current, cut.pending, NOW + 31 * DAY) }, PRODUCT), 40);

part("A raise applies at once, beside a cut that waits");
const mixed = planTerms(base, { percent: 35, rates: { [PRODUCT]: 25 }, days: 90 }, 14, NOW);
is("the store share and the window rise today", [mixed.current.percent, mixed.current.days], [35, 90]);
is("the product's cut waits: still 40% today", commissionRate({ ...NO_AFFILIATES, ...mixed.current }, PRODUCT), 40);
is("…and 25% from the day", commissionRate({ ...NO_AFFILIATES, ...termsAt(mixed.current, mixed.pending, NOW + 14 * DAY) }, PRODUCT), 25);
is("another product earns the raised share today", commissionRate({ ...NO_AFFILIATES, ...mixed.current }, OTHER), 35);

part("Taking a product out is a cut");
const out = planTerms(base, { ...base, rates: { [PRODUCT]: 0 } }, 7, NOW);
is("still in the program until the day", commissionRate({ ...NO_AFFILIATES, ...out.current }, PRODUCT), 40);
is("out from it", commissionRate({ ...NO_AFFILIATES, ...termsAt(out.current, out.pending, NOW + 7 * DAY) }, PRODUCT), 0);
const fallen = planTerms(base, { ...base, percent: 25, rates: {} }, 7, NOW);
is("a product falling back to a lower store share keeps its own until the day", commissionRate({ ...NO_AFFILIATES, ...fallen.current }, PRODUCT), 40);

part("No notice, or nothing worse: everything at once");
const now0 = planTerms(base, { ...base, percent: 10 }, 0, NOW);
is("no notice chosen: the cut applies today", [now0.current.percent, now0.pending], [10, null]);
const up = planTerms(base, { ...base, percent: 50 }, 30, NOW);
is("only better: nothing waits", [up.current.percent, up.pending], [50, null]);

part("Saving again during a notice");
const later = NOW + 10 * DAY;
const again = planTerms(cut.current, { ...base, percent: 20, days: 60 }, 30, later);
is("the window cut withdrawn: the window stays", again.pending?.days, 60);
is("the share cut still waits, from the new save", again.pending ? [again.pending.percent, again.pending.from] : null, [20, later + 30 * DAY]);
const undone = planTerms(cut.current, base, 30, later);
is("the creator puts the old terms back: nothing waits", undone.pending, null);
const same = planTerms(cut.current, { ...base, percent: 20, days: 30 }, 30, later, cut.pending);
is("saving the very terms announced (another field changed) keeps the day", same.pending?.from, NOW + 30 * DAY);
const sooner = planTerms(cut.current, { ...base, percent: 10, days: 30 }, 0, later, cut.pending);
is("a deeper cut with no notice now still waits for the day already announced", sooner.pending ? [sooner.pending.percent, sooner.pending.from] : null, [10, NOW + 30 * DAY]);
is("…and the terms of today stay the old ones", sooner.current.percent, 30);
const longer = planTerms(cut.current, { ...base, percent: 10, days: 30 }, 60, later, cut.pending);
is("a new notice that ends later moves the day later", longer.pending?.from, later + 60 * DAY);

part("Read back from storage only whole");
const bounds = { minPercent: 1, maxPercent: 90, minDays: 1, maxDays: 400 };
is("a whole pending change", readPending({ percent: 20, rates: { [PRODUCT]: 0 }, days: 30, from: NOW }, bounds), { percent: 20, rates: { [PRODUCT]: 0 }, days: 30, from: NOW });
is("a share out of bounds: none", readPending({ percent: 95, rates: {}, days: 30, from: NOW }, bounds), null);
is("no day: none", readPending({ percent: 20, rates: {}, days: 30 }, bounds), null);
is("a bad product id is dropped alone", readPending({ percent: 20, rates: { "<x>": 5, [PRODUCT]: 10 }, days: 30, from: NOW }, bounds)?.rates, { [PRODUCT]: 10 });

part("In words, only what gets worse");
const names = (id: string) => (id === PRODUCT ? "Knife Skills" : null);
is("store share and window", noticeLines(cut.current, cut.pending!, names), ["Commission: 30% becomes 20%.", "Days a click counts: 60 becomes 30."]);
is("a product taken out", noticeLines(out.current, out.pending!, names), ["Knife Skills: leaves the program (was 40%)."]);
is("a raise beside a cut says only the cut", noticeLines(mixed.current, mixed.pending!, names), ["Knife Skills: 40% becomes 25%."]);

done();
