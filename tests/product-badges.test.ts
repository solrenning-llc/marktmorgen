/**
 * 639 [GL7](31), unit 1: the labels on a product's card are worked out from
 * its own record, never claim anything about other buyers or about time
 * running out, and "New" never lasts longer than the product has been new.
 */
import { BADGE_WORDS, MAX_BADGES, NEW_DAYS, isNew, productBadges } from "@/lib/product-badges";
import { done, is, part } from "./check";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();
const plain = { createdAt: at(NOW - 30 * DAY), bundle: false, soon: false, preorder: false };

part("New, only for a few days after it was made");
is("made an hour ago: new", isNew(at(NOW - 3_600_000), NOW), true);
is("made a day before the end of the window: new", isNew(at(NOW - (NEW_DAYS - 1) * DAY), NOW), true);
is("made exactly NEW_DAYS ago: no longer new", isNew(at(NOW - NEW_DAYS * DAY), NOW), false);
is("made a month ago: not new", isNew(at(NOW - 30 * DAY), NOW), false);
is("a day in the future is never new", isNew(at(NOW + DAY), NOW), false);
is("an unknown day is never new", [isNew("", NOW), isNew("not a date", NOW)], [false, false]);
is("a plain product of last month has no label", productBadges(plain, NOW), []);
is("one made yesterday is labeled New", productBadges({ ...plain, createdAt: at(NOW - DAY) }, NOW), ["new"]);

part("Pre-order, coming soon and bundle, only while true");
is("taking pre-orders", productBadges({ ...plain, soon: true, preorder: true }, NOW), ["preorder"]);
is("coming soon without pre-orders", productBadges({ ...plain, soon: true }, NOW), ["soon"]);
is("not out yet is never New, however recent", productBadges({ ...plain, createdAt: at(NOW - DAY), soon: true }, NOW), ["soon"]);
is("a bundle", productBadges({ ...plain, bundle: true }, NOW), ["bundle"]);
is("a new bundle: both, bundle first", productBadges({ ...plain, bundle: true, createdAt: at(NOW - DAY) }, NOW), ["bundle", "new"]);
is("never more than the most, the one that changes what a buyer can do first", productBadges({ createdAt: at(NOW - DAY), bundle: true, soon: true, preorder: true }, NOW), ["preorder", "bundle"]);
is("the most is two", MAX_BADGES, 2);

part("Nothing about other buyers, counts or time running out");
const words = Object.values(BADGE_WORDS);
is("the whole list of what can be shown", words, ["Pre-order", "Coming soon", "Bundle", "New"]);
is("no claim about other buyers or scarcity", words.some((w) => /best|popular|trending|selling|limited|left|hurry|last|only|hot|sold|\d/i.test(w)), false);

done();
