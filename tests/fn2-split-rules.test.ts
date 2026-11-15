/**
 * 526 [FN2], unit 1: the rules of a funnel's "Split test" step
 * (lib/funnel-split-rules.ts). Pure: nothing here routes a visitor yet; the
 * funnel's address, the studio editor and the counts per version are the
 * next units.
 *
 * A split step sends each visitor to one of two to four of the store's own
 * pages or products, drawn afresh at each visit with no cookie and nothing
 * about the person, in shares the creator chose (whole percents adding up to
 * 100) or equal. The versions are named a–d as the winner rule of 377 [TB3]
 * (lib/ab-decision.ts) names them, so the same rule decides, never a second
 * one.
 *
 * What fails here:
 *   - fewer than two or more than four destinations, one used twice, an id or
 *     a kind that is not a page or a product of the store;
 *   - shares that are not whole percents from 1 to 99, or do not add up to 100;
 *   - equal shares that do not add up to 100;
 *   - a destination that is off the air keeping its share, or its share lost
 *     instead of passed to the others;
 *   - a draw outside [0, 1) taken as a draw, or a draw that ignores the shares;
 *   - a version name other than lib/ab-decision.ts's.
 */
import { AB_MAX_VERSIONS, AB_MIN_VERSIONS, AB_VERSION_IDS } from "@/lib/ab-decision";
import { equalShares, liveShares, parseSplit, pickShare, splitVersion, SPLIT_MAX, SPLIT_MIN } from "@/lib/funnel-split-rules";
import { done, is, part } from "./check";

const page = (id: string, share?: number) => ({ kind: "page", id, ...(share === undefined ? {} : { share }) });
const product = (id: string, share?: number) => ({ kind: "product", id, ...(share === undefined ? {} : { share }) });

part("Two to four of the store's own pages or products");
is("the same bounds as the winner rule", [SPLIT_MIN, SPLIT_MAX], [AB_MIN_VERSIONS, AB_MAX_VERSIONS]);
is("two, equal by default", parseSplit({ options: [page("pageA"), product("prodB")] }), { kind: "split", options: [{ kind: "page", id: "pageA", share: 50 }, { kind: "product", id: "prodB", share: 50 }] });
is("one alone is no test", parseSplit({ options: [page("pageA")] }), null);
is("five is too many", parseSplit({ options: ["a1", "b1", "c1", "d1", "e1"].map((id) => page(id)) }), null);
is("the same destination twice", parseSplit({ options: [page("pageA"), page("pageA")] }), null);
is("a page and a product may share an id", parseSplit({ options: [page("same1"), product("same1")] })?.options.length, 2);
is("a link, a call or anything else is not a destination", [parseSplit({ options: [page("pageA"), { kind: "url", id: "https://x" }] }), parseSplit({ options: [page("pageA"), { kind: "page", id: "../x" }] })], [null, null]);
is("nothing readable", [parseSplit(undefined), parseSplit("split"), parseSplit({ options: "a" })], [null, null, null]);

part("Shares: whole percents that add up to 100, or equal");
is("the creator's own", parseSplit({ options: [page("pageA", 70), product("prodB", 30)] })?.options.map((o) => o.share), [70, 30]);
is("not adding up to 100", parseSplit({ options: [page("pageA", 70), product("prodB", 20)] }), null);
is("a fraction, zero, a hundred or text", [parseSplit({ options: [page("pageA", 50.5), product("prodB", 49.5)] }), parseSplit({ options: [page("pageA", 0), product("prodB", 100)] }), parseSplit({ options: [page("pageA", "50" as unknown as number), product("prodB", 50)] })], [null, null, null]);
is("some given and some not", parseSplit({ options: [page("pageA", 60), product("prodB")] }), null);
is("equal for two, three and four, adding up to 100", [equalShares(2), equalShares(3), equalShares(4)], [[50, 50], [34, 33, 33], [25, 25, 25, 25]]);
is("four with equal shares", parseSplit({ options: ["a1", "b1", "c1", "d1"].map((id) => page(id)) })?.options.map((o) => o.share), [25, 25, 25, 25]);

part("A destination off the air passes its share to the others");
const three = parseSplit({ options: [page("pageA", 50), page("pageB", 30), page("pageC", 20)] })!;
is("all on: as chosen", liveShares(three.options, () => true).map((o) => [o.id, o.share, o.version]), [["pageA", 50, "a"], ["pageB", 30, "b"], ["pageC", 20, "c"]]);
const without = liveShares(three.options, (o) => o.id !== "pageB");
is("one off: the rest in proportion, still 100, versions kept", without.map((o) => [o.id, o.share, o.version]), [["pageA", 71, "a"], ["pageC", 29, "c"]]);
is("never more or less than 100", liveShares(parseSplit({ options: [page("pageA", 34), page("pageB", 33), page("pageC", 33)] })!.options, (o) => o.id !== "pageA").reduce((sum, o) => sum + o.share, 0), 100);
is("one left: it takes everyone", liveShares(three.options, (o) => o.id === "pageC").map((o) => [o.id, o.share]), [["pageC", 100]]);
is("none left: none, so the funnel passes over the step", liveShares(three.options, () => false), []);

part("The draw: once a visit, by the shares, nothing else");
const live = liveShares(three.options, () => true);
is("the low end goes to the first", pickShare(live, 0)?.id, "pageA");
is("just under its share, still the first", pickShare(live, 0.4999)?.id, "pageA");
is("at its share, the next", pickShare(live, 0.5)?.id, "pageB");
is("the top end goes to the last", pickShare(live, 0.9999)?.id, "pageC");
is("a draw outside [0, 1) or not a number is never taken", [pickShare(live, 1), pickShare(live, -0.1), pickShare(live, Number.NaN), pickShare(live, "0.2" as never)], [null, null, null, null]);
is("nothing live: nothing drawn", pickShare([], 0.3), null);
const counts = [0, 0, 0];
for (let i = 0; i < 10_000; i += 1) counts[["pageA", "pageB", "pageC"].indexOf(pickShare(live, i / 10_000)!.id)] += 1;
is("an even spread of draws lands in the chosen shares", counts, [5_000, 3_000, 2_000]);
is("the draw takes no person, cookie or address", pickShare.length, 2);

part("Version names are the winner rule's");
is("a to d by place", [0, 1, 2, 3].map(splitVersion), [...AB_VERSION_IDS]);
is("no fifth", splitVersion(4), null);

done();
