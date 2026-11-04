/**
 * A one-time booking link for one person (637 [GL5], unit 4a; added
 * 3 November 2026): the rules, on synthetic links only.
 */
import { BOOKING_LINK_DAYS, type BookingLink, DEFAULT_LINK_DAYS, LINK_PROBLEMS, LINK_TOKEN, type LetGo, letGo, linkEnd, linkState, linkStateWords, mayBook, mayConfirm, opensFor, readLinkRequest, resumable } from "@/lib/booking-link-rules";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NY = "America/New_York";
const MADE = Date.UTC(2026, 10, 3, 15, 0);
const link: BookingLink = { store: "s1", product: "p1", email: "ana@example.com", madeAt: MADE, expiresAt: MADE + 7 * DAY };

part("Made from the studio");
is("for one call, a week by default", readLinkRequest({ product: "p1" }, "s1", MADE, NY), { ok: true, link: { store: "s1", product: "p1", madeAt: MADE, expiresAt: MADE + DEFAULT_LINK_DAYS * DAY } });
is("for one person, their address as typed, made lower case", readLinkRequest({ product: "p1", days: "30", email: "  Ana@Example.com " }, "s1", MADE, NY), { ok: true, link: { store: "s1", product: "p1", email: "ana@example.com", madeAt: MADE, expiresAt: MADE + 30 * DAY } });
is("only the days on the list", [1, 3, 7, 14, 30].every((d) => readLinkRequest({ product: "p1", days: d }, "s1", MADE, NY).ok), true);
// Made on Thursday 29 October 2026 at 10:00 AM in New York (EDT); the clocks go back on Sunday 1 November.
const BEFORE_CHANGE = Date.UTC(2026, 9, 29, 14, 0);
is("ends at the same clock time in the creator's zone, across a change of the clocks", [readLinkRequest({ product: "p1", days: 7 }, "s1", BEFORE_CHANGE, NY), new Intl.DateTimeFormat("en-US", { timeZone: NY, dateStyle: "long", timeStyle: "short" }).format(linkEnd(BEFORE_CHANGE, 7, NY))], [{ ok: true, link: { store: "s1", product: "p1", madeAt: BEFORE_CHANGE, expiresAt: BEFORE_CHANGE + 7 * DAY + HOUR } }, "November 5, 2026 at 10:00 AM"]);
// Made on Saturday 7 March 2026 at 2:30 AM in New York; on Sunday 8 March 2:30 does not exist.
is("a clock time skipped on its last day: an hour later", new Intl.DateTimeFormat("en-US", { timeZone: NY, dateStyle: "long", timeStyle: "short" }).format(linkEnd(Date.UTC(2026, 2, 7, 7, 30), 1, NY)), "March 8, 2026 at 3:30 AM");
is("in UTC when the zone is not one, and to the second", [linkEnd(MADE + 42_000, 3, "Not/AZone"), linkEnd(MADE + 42_000, 3, "UTC")], [MADE + 42_000 + 3 * DAY, MADE + 42_000 + 3 * DAY]);
is("refused: no call, another number of days, an address that is not one", [readLinkRequest({ days: 7 }, "s1", MADE, NY), readLinkRequest({ product: "../x", days: 7 }, "s1", MADE, NY), readLinkRequest({ product: "p1", days: 2 }, "s1", MADE, NY), readLinkRequest({ product: "p1", days: 365 }, "s1", MADE, NY), readLinkRequest({ product: "p1", email: "ana" }, "s1", MADE, NY), readLinkRequest({ product: "p1", email: `${"a".repeat(250)}@b.co` }, "s1", MADE, NY)], [{ ok: false, why: "product" }, { ok: false, why: "product" }, { ok: false, why: "days" }, { ok: false, why: "days" }, { ok: false, why: "email" }, { ok: false, why: "email" }]);
is("days only as a whole number, never true, a list or a decimal", [true, [7], "7.0", " 7", 7.5].map((days) => readLinkRequest({ product: "p1", days }, "s1", MADE, NY).ok), [false, false, false, false, false]);
is("each problem says how to fix it", LINK_PROBLEMS.days, `Pick how long the link works: ${BOOKING_LINK_DAYS.slice(0, -1).join(", ")} or 30 days.`);
is("its token is 48 hex characters", [LINK_TOKEN.test("a".repeat(48)), LINK_TOKEN.test("a".repeat(47)), LINK_TOKEN.test("A".repeat(48))], [true, false, false]);

part("Used once, then never again");
is("open until its day", [linkState(link, MADE), linkState(link, MADE + 7 * DAY - 1)], ["open", "open"]);
is("expired from its day", linkState(link, MADE + 7 * DAY), "expired");
const held: BookingLink = { ...link, heldBy: "cs_test_a" };
is("held while a checkout opened from it is open: no new checkout from another tab", [linkState(held, MADE + 60_000), mayBook(held, MADE + 60_000)], ["held", false]);
is("a buyer coming back is sent to that same checkout, never a second one", [resumable(held, MADE + 60_000, "cs_test_a"), resumable(held, MADE + 60_000, "cs_test_b"), resumable(link, MADE, "cs_test_a")], [true, false, false]);
is("held until Stripe reports that checkout expired, never let go by a clock of ours: still held hours later", linkState(held, MADE + 5 * 3_600_000), "held");
is("let go when Stripe reports it expired unpaid: open again before its day, expired after it", [linkState({ ...held, heldBy: undefined }, MADE + DAY), mayBook({ ...held, heldBy: undefined }, MADE + DAY), linkState({ ...held, heldBy: undefined }, MADE + 7 * DAY)], ["open", true, "expired"]);
is("past its day, a checkout opened before it is still held and may be paid, but no new checkout opens", [linkState(held, MADE + 7 * DAY + 60_000), mayBook(held, MADE + 7 * DAY + 60_000), mayConfirm(held, "cs_test_a")], ["held", false, true]);
is("only the checkout that holds it may book from it: another paid one is refunded, never the one the buyer was sent to", [mayConfirm(held, "cs_test_a"), mayConfirm(held, "cs_test_b"), mayConfirm(link, "cs_test_a")], [true, false, false]);
const paying: BookingLink = { ...held, paying: true };
is("a checkout completed with its payment on its way: no new checkout, nobody sent back to the closed checkout, its payment still books", [linkState(paying, MADE + 60_000), mayBook(paying, MADE + 60_000), resumable(paying, MADE + 60_000, "cs_test_a"), mayConfirm(paying, "cs_test_a")], ["paying", false, false, true]);
const reasons: LetGo[] = ["expired", "payment_failed", "refunded_unbooked"];
is("let go when its checkout expired, its later payment failed, or it was refunded without a booking: open again", reasons.map((why) => [linkState(letGo(paying, "cs_test_a", why), MADE + DAY), mayBook(letGo(held, "cs_test_a", why), MADE + DAY)]), [["open", true], ["open", true], ["open", true]]);
is("a report about another checkout, of anything else, or on a used link changes nothing", [letGo(held, "cs_test_b", "expired"), letGo(held, "cs_test_a", "complete" as LetGo), letGo({ ...held, usedAt: MADE + 600_000 }, "cs_test_a", "refunded_unbooked")], [held, held, { ...held, usedAt: MADE + 600_000 }]);
const used: BookingLink = { ...held, usedAt: MADE + 600_000 };
is("used: it never opens again, not even before its day or from the checkout that used it", [linkState(used, MADE + 600_001), mayBook(used, MADE + 600_001), resumable(used, MADE + 600_001, "cs_test_a"), mayConfirm(used, "cs_test_a"), linkState(used, MADE + 30 * DAY), linkState({ ...link, usedAt: 0 }, MADE)], ["used", false, false, false, "used", "used"]);

part("The store's own link, for its own call");
is("opens only under its store and for its product", [opensFor(link, "s1", "p1"), opensFor(link, "s2", "p1"), opensFor(link, "s1", "p2")], [true, false, false]);

part("Said in the studio");
is("open, made out to one person, never claimed to be only theirs, with the time zone said", linkStateWords(link, MADE, "America/New_York"), "Made out to ana@example.com; anyone with the link can use it once, until November 10, 2026 at 10:00 AM EST.");
is("held: a checkout is open on it", linkStateWords(held, MADE, "America/New_York").startsWith("A checkout is open on it now. Made out to ana@example.com"), true);
is("held past its day: a checkout is open, and the link expired, never 'until' a day gone", linkStateWords(held, MADE + 8 * DAY, "America/New_York"), "A checkout is open on it now. The link expired on November 10, 2026 at 10:00 AM EST, so no new checkout opens.");
is("paying: said so", linkStateWords(paying, MADE, "America/New_York"), "A payment made from it is on its way. The call is booked when it arrives, if the time is still free. Otherwise the payment is refunded.");
is("with no address, anyone with the link", linkStateWords({ ...link, email: undefined }, MADE, "America/New_York").startsWith("Anyone with the link can use it once, until"), true);
is("used and expired say it no longer opens", [linkStateWords(used, MADE + DAY, "America/New_York"), linkStateWords(link, MADE + 8 * DAY, "America/New_York")], ["Used: booked on November 3, 2026 at 10:10 AM EST. It no longer opens.", "Expired on November 10, 2026 at 10:00 AM EST. It no longer opens."]);
is("in UTC when the time zone kept is not one", linkStateWords(link, MADE, "Not/AZone").endsWith("UTC."), true);

done();
