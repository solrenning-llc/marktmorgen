/**
 * A one-time booking link for one person (637 [GL5], unit 4a; added
 * 3 November 2026): the rules, on synthetic links only.
 */
import { BOOKING_LINK_DAYS, type BookingLink, DEFAULT_LINK_DAYS, LINK_PROBLEMS, LINK_TOKEN, linkState, linkStateWords, mayBook, readLinkRequest } from "@/lib/booking-link-rules";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const MADE = Date.UTC(2026, 10, 3, 15, 0);
const link: BookingLink = { product: "p1", email: "ana@example.com", madeAt: MADE, expiresAt: MADE + 7 * DAY };

part("Made from the studio");
is("for one call, a week by default", readLinkRequest({ product: "p1" }, MADE), { ok: true, link: { product: "p1", madeAt: MADE, expiresAt: MADE + DEFAULT_LINK_DAYS * DAY } });
is("for one person, their address as typed, made lower case", readLinkRequest({ product: "p1", days: "30", email: "  Ana@Example.com " }, MADE), { ok: true, link: { product: "p1", email: "ana@example.com", madeAt: MADE, expiresAt: MADE + 30 * DAY } });
is("only the days on the list", [1, 3, 7, 14, 30].every((d) => readLinkRequest({ product: "p1", days: d }, MADE).ok), true);
is("refused: no call, another number of days, an address that is not one", [readLinkRequest({ days: 7 }, MADE), readLinkRequest({ product: "../x", days: 7 }, MADE), readLinkRequest({ product: "p1", days: 2 }, MADE), readLinkRequest({ product: "p1", days: 365 }, MADE), readLinkRequest({ product: "p1", email: "ana" }, MADE)], [{ ok: false, why: "product" }, { ok: false, why: "product" }, { ok: false, why: "days" }, { ok: false, why: "days" }, { ok: false, why: "email" }]);
is("each problem says how to fix it", LINK_PROBLEMS.days, `Pick how long the link works: ${BOOKING_LINK_DAYS.slice(0, -1).join(", ")} or 30 days.`);
is("its token is 48 hex characters", [LINK_TOKEN.test("a".repeat(48)), LINK_TOKEN.test("a".repeat(47)), LINK_TOKEN.test("A".repeat(48))], [true, false, false]);

part("Used once, then never again");
is("open until its day", [linkState(link, MADE), linkState(link, MADE + 7 * DAY - 1)], ["open", "open"]);
is("expired from its day", linkState(link, MADE + 7 * DAY), "expired");
const held = { ...link, heldBy: "cs_test_a", heldUntil: MADE + 1800_000 };
is("held while a checkout opened from it is open: no second booking from another tab", [linkState(held, MADE + 60_000), mayBook(held, MADE + 60_000), mayBook(held, MADE + 60_000, "cs_test_b"), mayBook(held, MADE + 60_000, "cs_test_a")], ["held", false, false, true]);
is("a checkout closed unpaid lets it go again", [linkState(held, MADE + 1800_000), mayBook(held, MADE + 1800_000)], ["open", true]);
const used = { ...held, usedAt: MADE + 600_000 };
is("used: it never opens again, not even before its day or from the checkout that used it", [linkState(used, MADE + 600_001), mayBook(used, MADE + 600_001), mayBook(used, MADE + 600_001, "cs_test_a"), linkState(used, MADE + 30 * DAY)], ["used", false, false, "used"]);

part("Said in the studio");
is("open, for one person", linkStateWords(link, MADE, "America/New_York"), "Works for one booking, for ana@example.com, until November 10, 2026 at 10:00 AM.");
is("for whoever has it", linkStateWords({ ...link, email: undefined }, MADE, "America/New_York").includes("for whoever has it"), true);
is("used and expired say it no longer opens", [linkStateWords(used, MADE + DAY, "America/New_York"), linkStateWords(link, MADE + 8 * DAY, "America/New_York")], ["Used: booked on November 3, 2026 at 10:10 AM. It no longer opens.", "Expired on November 10, 2026 at 10:00 AM. It no longer opens."]);
is("in UTC when the time zone kept is not one", linkStateWords(link, MADE, "Not/AZone").endsWith("UTC."), true);

done();
