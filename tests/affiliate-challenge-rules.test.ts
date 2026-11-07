/**
 * Challenges for affiliates (384 [TB10], unit 1: lib/affiliate-challenge-rules.ts).
 *
 * Pure rules only: what a challenge may say, and the standings worked out
 * from the affiliate book the page already reads (lib/affiliates.ts readBook).
 * No read, no write and no call of its own.
 */
import * as challengeRules from "@/lib/affiliate-challenge-rules";
import {
  CHALLENGE_MAX_DAYS,
  CHALLENGE_MAX_TITLE,
  CHALLENGE_SETTLE_DAYS,
  type Challenge,
  challengeBoard,
  challengeNotes,
  challengePhase,
  challengeStandings,
  readBoardName,
  readChallenge,
} from "@/lib/affiliate-challenge-rules";
import { AFFILIATE_ID_PATTERN, type Affiliate, type Book, type Credit, type Line, type LineStatus, type Row } from "@/lib/affiliates";
import { MAX_AFFILIATES } from "@/lib/affiliate-setting";
import { done, is, part } from "./check";

const DAY = 86_400;
const T0 = 1_800_000_000; // seconds
const NOW_MS = (T0 - DAY) * 1000;

const typed = {
  title: "  Spring   push  ",
  start: T0,
  end: T0 + 14 * DAY,
  goal: 5,
  places: 3,
  products: ["p1"],
  prize: { kind: "product", label: "My full course, free for a year" },
};

function affiliate(id: string, over: Partial<Affiliate> = {}): Affiliate {
  return {
    id,
    email: `${id}@example.test`,
    code: id,
    status: "approved",
    appliedAt: 0,
    decidedAt: 0,
    note: "",
    rate: null,
    paypal: "",
    share: null,
    cleared: null,
    by: null,
    ...over,
  };
}

function row(id: string, over: Partial<Affiliate> = {}, flags: Row["flags"] = []): Row {
  return {
    affiliate: affiliate(id, over),
    clicks: 0,
    sales: 0,
    earned: 0,
    paid: 0,
    owed: 0,
    waiting: 0,
    payable: 0,
    held: flags.length ? 100 : 0,
    flags,
    paidClicks: 0,
  };
}

let n = 0;
function sale(aff: string, at: number, over: Partial<Line> = {}): Line {
  n += 1;
  return {
    ref: `cs_${n}`,
    pi: `pi_${n}`,
    aff,
    at,
    product: "p1",
    title: "Course",
    base: 5000,
    total: 5000,
    currency: "usd",
    rate: 30,
    self: false,
    how: "click" as Credit,
    refunded: 0,
    commission: 1500,
    status: "earned" as LineStatus,
    ...over,
  };
}

function book(lines: Line[], rows: Row[], over: Partial<Book> = {}): Book {
  return { rows, lines, payouts: [], currency: "usd", elsewhere: 0, refundsChecked: true, invoicesChecked: true, ...over };
}

part("What a challenge may say");
const read = readChallenge(typed, NOW_MS);
is("a whole challenge is read, title tidied", read, {
  ok: true,
  challenge: { title: "Spring push", start: T0, end: T0 + 14 * DAY, goal: 5, places: 3, products: ["p1"], prize: { kind: "product", label: "My full course, free for a year" } },
});
is("no goal and no product list: every product, places only", readChallenge({ ...typed, goal: undefined, products: undefined }, NOW_MS), {
  ok: true,
  challenge: { title: "Spring push", start: T0, end: T0 + 14 * DAY, goal: 0, places: 3, products: [], prize: { kind: "product", label: "My full course, free for a year" } },
});
const refused = (over: Record<string, unknown>) => {
  const r = readChallenge({ ...typed, ...over }, NOW_MS);
  return r.ok ? "accepted" : r.problem;
};
is("no title", refused({ title: "   " }), "title");
is("a title too long", refused({ title: "x".repeat(CHALLENGE_MAX_TITLE + 1) }), "title");
is("ends before it starts", refused({ end: T0 - DAY }), "dates");
is("ends when it starts", refused({ end: T0 }), "dates");
is("shorter than a day", refused({ end: T0 + DAY - 1 }), "dates");
is("longer than the most allowed", refused({ end: T0 + (CHALLENGE_MAX_DAYS + 1) * DAY }), "dates");
is("the most allowed is fine", refused({ end: T0 + CHALLENGE_MAX_DAYS * DAY }), "accepted");
is("a date that is not a whole second", refused({ start: T0 + 0.5 }), "dates");
is("a date in milliseconds by mistake", refused({ start: T0 * 1000, end: (T0 + DAY) * 1000 }), "dates");
is("already over when it is set", refused({ start: T0 - 30 * DAY, end: T0 - 20 * DAY }), "dates");
is("more than a year ahead", refused({ start: T0 + 400 * DAY, end: T0 + 410 * DAY }), "dates");
is("no places and no goal: nobody could win", refused({ places: 0, goal: 0 }), "winners");
is("a goal alone is enough", refused({ places: 0, goal: 3 }), "accepted");
is("too many places", refused({ places: 11 }), "winners");
is("a goal that is not a whole number", refused({ goal: 2.5 }), "winners");
is("a goal too high", refused({ goal: 10_001 }), "winners");
is("a cash prize is not a kind we offer: Marktmorgen pays no prize", refused({ prize: { kind: "cash", label: "$500" } }), "prize");
is("a prize with no words", refused({ prize: { kind: "coupon", label: "  " } }), "prize");
is("a prize with a link", refused({ prize: { kind: "access", label: "See https://example.test" } }), "prize");
is("no prize at all", refused({ prize: undefined }), "prize");
is("a product id that is not one", refused({ products: ["p1", ""] }), "products");
is("too many products", refused({ products: Array.from({ length: 51 }, (_, i) => `p${i}`) }), "products");
is("a repeated product is kept once", readChallenge({ ...typed, products: ["p1", "p1", "p2"] }, NOW_MS).ok && (readChallenge({ ...typed, products: ["p1", "p1", "p2"] }, NOW_MS) as { challenge: Challenge }).challenge.products, ["p1", "p2"]);
is("not an object", [readChallenge(null, NOW_MS).ok, readChallenge("x", NOW_MS).ok, readChallenge([], NOW_MS).ok], [false, false, false]);

part("No money and no promise of earnings, in the title or the prize");
for (const label of [
  "$500 cash",
  "PayPal transfer",
  "Earn $1,000 guaranteed",
  "500 USD",
  "USD 500",
  "500usd",
  "1,000 EUR to spend",
  "\u20ac50 to spend",
  "\u00a320 voucher",
  "R$ 100",
  "Cash prize",
  "Prize money",
  "A bank transfer",
  "Paid by Venmo",
  "Zelle payment",
  "One Bitcoin",
  "A gift card",
  "50 dollars",
  "20 bucks",
  "Guaranteed results",
  "Everybody earns",
  "Your earnings doubled",
  "Higher commission for a month",
  "Payout of the month",
]) {
  is(`a prize that is money or a promise of earnings is refused: ${JSON.stringify(label)}`, refused({ prize: { kind: "product", label } }), "money");
}
for (const title of ["Win $500", "Earn $1,000 guaranteed", "500 USD challenge", "Cash race", "PayPal sprint", "Make money in May"]) {
  is(`a title that is money or a promise of earnings is refused: ${JSON.stringify(title)}`, refused({ title }), "money");
}
for (const label of ["Free access to my course", "10% off coupon", "My PHP 8 course, free", "All 5 templates", "Try 2 months of coaching", "A signed copy of my book", "Lifetime access to the community"]) {
  is(`a neutral prize passes: ${JSON.stringify(label)}`, refused({ prize: { kind: "access", label } }), "accepted");
}
for (const title of ["Top 3 sellers win", "Spring push", "Summer sprint 2027", "Transformation challenge"]) {
  is(`a neutral title passes: ${JSON.stringify(title)}`, refused({ title }), "accepted");
}
is("a cash kind is still refused as a kind we do not offer", refused({ prize: { kind: "cash", label: "Free access to my course" } }), "prize");

part("Who the creator left out is kept");
const left = readChallenge({ ...typed, excluded: ["0123456789ab", "0123456789ab", "ba9876543210"] }, NOW_MS);
is("the affiliates left out are kept, each once", left.ok ? left.challenge.excluded : left.problem, ["0123456789ab", "ba9876543210"]);
is("nobody left out reads as no list", readChallenge(typed, NOW_MS).ok && "excluded" in (readChallenge(typed, NOW_MS) as { challenge: Challenge }).challenge, false);
is("an id that is not an affiliate's is refused", refused({ excluded: ["0123456789ab", "x"] }), "excluded");
is("an id in capitals is refused", refused({ excluded: ["0123456789AB"] }), "excluded");
is("a list that is not a list is refused", refused({ excluded: "0123456789ab" }), "excluded");
is("more than every affiliate a store can have is refused", refused({ excluded: Array.from({ length: challengeRules.CHALLENGE_MAX_EXCLUDED + 1 }, (_, i) => i.toString(16).padStart(12, "0")) }), "excluded");
is("the most left out is the most affiliates a store can have", challengeRules.CHALLENGE_MAX_EXCLUDED, MAX_AFFILIATES);
is("the id shape is the book's own", AFFILIATE_ID_PATTERN.test("0123456789ab") && !AFFILIATE_ID_PATTERN.test("x"), true);
const leftOut = left.ok ? challengeStandings(left.challenge, book([sale("0123456789ab", T0 + 10), sale("cccccccccccc", T0 + 20)], [row("0123456789ab"), row("cccccccccccc")])) : null;
is("a challenge read back leaves them out of the standings", leftOut && leftOut.ok ? leftOut.standings.map((x) => x.aff) : leftOut, ["cccccccccccc"]);

const c = (read as { ok: true; challenge: Challenge }).challenge;

part("Where a challenge is in time");
is("before it starts", challengePhase(c, (T0 - 1) * 1000), "upcoming");
is("from its first second", challengePhase(c, T0 * 1000), "running");
is("until its last second", challengePhase(c, (c.end - 1) * 1000), "running");
is("from its end, places can still change", challengePhase(c, c.end * 1000), "settling");
is("until the wait is over", challengePhase(c, (c.end + CHALLENGE_SETTLE_DAYS * DAY - 1) * 1000), "settling");
is("then it is over", challengePhase(c, (c.end + CHALLENGE_SETTLE_DAYS * DAY) * 1000), "over");

part("Which sales count");
const rows = [row("a"), row("b"), row("c"), row("d")];
const counted = (line: Line, b: Partial<Book> = {}) => {
  const s = challengeStandings(c, book([line], rows, b));
  return s.ok ? s.standings.map((x) => x.sales) : s.problem;
};
is("a paid sale of a listed product inside the dates", counted(sale("a", T0 + 10)), [1]);
is("a sale before the start", counted(sale("a", T0 - 1)), []);
is("a sale at the end second is outside", counted(sale("a", c.end)), []);
is("another product", counted(sale("a", T0 + 10, { product: "p9" })), []);
is("the affiliate's own purchase", counted(sale("a", T0 + 10, { self: true, status: "own purchase", commission: 0 })), []);
is("refunded in full", counted(sale("a", T0 + 10, { refunded: 5000, status: "refunded", commission: 0 })), []);
is("a lost or held dispute reads as refunded, so it does not count", counted(sale("a", T0 + 10, { refunded: 5000, status: "refunded", commission: 0, how: "code" })), []);
// Changed (TB10 pre-review): was "partly refunded: still a sale", [1]. The
// count is of whole sales only, so a sale refunded in part no longer counts;
// the page says so (challengeNotes).
is("partly refunded: not a whole sale, so it does not count", counted(sale("a", T0 + 10, { refunded: 1000, status: "partly refunded", commission: 1200 })), []);
is("a sale the book calls earned but with money given back does not count", counted(sale("a", T0 + 10, { refunded: 1 })), []);
is("a free product is not a sale", counted(sale("a", T0 + 10, { base: 0, total: 0, commission: 0 })), []);
for (const how of ["code", "buyer", "contact"] as const) is(`credited by ${how}: a sale they brought`, counted(sale("a", T0 + 10, { how })), [1]);
for (const how of ["recurring", "partner", "bonus", "tier2", "lead"] as const) is(`credited as ${how}: not a new sale they brought`, counted(sale("a", T0 + 10, { how })), []);
is("a sale in another currency is still a sale", counted(sale("a", T0 + 10, { currency: "eur" })), [1]);
is("refunds not checked: no standings at all, never a guess", counted(sale("a", T0 + 10), { refundsChecked: false }), "refunds");
const twice = sale("a", T0 + 10);
const dup = challengeStandings(c, book([twice, { ...twice }], rows));
is("the same payment twice on the book is one sale", dup.ok ? dup.standings.map((x) => x.sales) : dup.problem, [1]);
is("a status the book does not know is not counted", counted(sale("a", T0 + 10, { status: "something new" as LineStatus })), []);

part("Who can be placed");
const only = (r: Row[]) => {
  const s = challengeStandings(c, book([sale("a", T0 + 10)], r));
  return s.ok ? s.standings.map((x) => x.aff) : s.problem;
};
is("an approved affiliate", only([row("a")]), ["a"]);
is("a removed affiliate", only([row("a", { status: "removed" })]), []);
is("a pending one", only([row("a", { status: "pending" })]), []);
is("held for a shared address: not placed until the creator looks", only([row("a", {}, ["same-address"])]), []);
is("held for paid search clicks", only([row("a", {}, ["paid-search"])]), []);
is("a sale for somebody not on the book", only([row("b")]), []);
const kept = challengeStandings({ ...c, excluded: ["a"] }, book([sale("a", T0 + 10)], [row("a")]));
is("left out by the creator", kept.ok ? kept.standings : kept.problem, []);
const under = challengeStandings(c, book([sale("a", T0 + 10)], [row("a", {}, ["same-address"])]));
is("held affiliates are listed apart, so the creator can look", under.ok ? under.review : under.problem, ["a"]);

part("Places and ties");
const lines = [
  sale("a", T0 + 100),
  sale("a", T0 + 200),
  sale("b", T0 + 150),
  sale("b", T0 + 180),
  sale("c", T0 + 50),
  sale("d", T0 + 300),
  sale("d", T0 + 400),
  sale("d", T0 + 500),
];
const s1 = challengeStandings(c, book(lines, rows));
is(
  "most sales first; on the same count, who got there first",
  s1.ok ? s1.standings.map((x) => [x.place, x.aff, x.sales, x.reachedAt]) : s1.problem,
  [
    [1, "d", 3, T0 + 500],
    [2, "b", 2, T0 + 180],
    [3, "a", 2, T0 + 200],
    [4, "c", 1, T0 + 50],
  ],
);
is("the top places win; nobody reached the goal of 5", s1.ok ? s1.standings.map((x) => x.wins) : s1.problem, [true, true, true, false]);
const s2 = challengeStandings(c, book([sale("a", T0 + 100), sale("b", T0 + 100)], rows));
is("the same count at the same second: the same place", s2.ok ? s2.standings.map((x) => [x.place, x.aff]) : s2.problem, [
  [1, "a"],
  [1, "b"],
]);
const s3 = challengeStandings({ ...c, places: 1 }, book([sale("a", T0 + 100), sale("b", T0 + 100), sale("c", T0 + 150)], rows));
is("a shared last winning place: both win", s3.ok ? s3.standings.map((x) => [x.aff, x.wins]) : s3.problem, [
  ["a", true],
  ["b", true],
  ["c", false],
]);
const goal = challengeStandings({ ...c, places: 0, goal: 2 }, book(lines, rows));
is("a goal: everybody who reached it wins", goal.ok ? goal.standings.map((x) => [x.aff, x.wins]) : goal.problem, [
  ["d", true],
  ["b", true],
  ["a", true],
  ["c", false],
]);
const late = challengeStandings(c, book([...lines.slice(0, 7), sale("d", T0 + 500, { refunded: 5000, status: "refunded", commission: 0 })], rows));
is(
  "a later refund takes the sale off, even after the end",
  late.ok ? late.standings.map((x) => [x.place, x.aff, x.sales]) : late.problem,
  [
    [1, "b", 2],
    [2, "a", 2],
    [3, "d", 2],
    [4, "c", 1],
  ],
);

part("What an affiliate sees");
const names = { b: "Bea R." };
const board = s1.ok ? challengeBoard(s1.standings, "a", names) : null;
is("their own row says You; a name only with consent; never an address", board, {
  rows: [
    { place: 1, label: "An affiliate", sales: 3, you: false, wins: true },
    { place: 2, label: "Bea R.", sales: 2, you: false, wins: true },
    { place: 3, label: "You", sales: 2, you: true, wins: true },
    { place: 4, label: "An affiliate", sales: 1, you: false, wins: false },
  ],
  mine: { place: 3, sales: 2 },
});
is("no address ever shows", JSON.stringify(board).includes("@"), false);
const short = s1.ok ? challengeBoard(s1.standings, "c", {}, 2) : null;
is("a short board still gives their own place", short, {
  rows: [
    { place: 1, label: "An affiliate", sales: 3, you: false, wins: true },
    { place: 2, label: "An affiliate", sales: 2, you: false, wins: true },
  ],
  mine: { place: 4, sales: 1 },
});
const none = s1.ok ? challengeBoard(s1.standings, "zz", {}) : null;
is("no sale yet: no place, zero sales", none && none.mine, { place: null, sales: 0 });

part("A name on the board");
is("tidied", readBoardName("  Bea   R. "), "Bea R.");
is("letters from any language", readBoardName("José Ñúñez"), "José Ñúñez");
is("a name that only starts like a reserved one is fine", [readBoardName("Youssef"), readBoardName("Anna Affiliate-Smith")], ["Youssef", "Anna Affiliate-Smith"]);
for (const bad of ["", " ", "x", "bea@example.test", "see www.x.test", "http://x", "a".repeat(31), "<b>", 42, null, "You", "you", " YOU. ", "An affiliate", "an  affiliate", "Affiliate", "Marktmorgen"]) {
  is(`${JSON.stringify(bad)} is refused`, readBoardName(bad), null);
}

part("What the page says");
const words = challengeNotes(c, (c.end + 1) * 1000);
is("after the end, it says places can still change and when to hand out prizes", words.some((w) => w.includes("refund") && w.includes("can still change")), true);
is("it names the day to wait for", words.some((w) => w.includes(new Date((c.end + CHALLENGE_SETTLE_DAYS * DAY) * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }))), true);
is("it says the prize is the creator's, never Marktmorgen's", challengeNotes(c, NOW_MS).some((w) => w.includes("from you") && w.includes("Marktmorgen does not pay")), true);
is("it says a sale refunded in part does not count either", challengeNotes(c, NOW_MS).some((w) => w.includes("refunded in whole or in part")), true);
is("it never promises earnings", challengeNotes(c, NOW_MS).some((w) => /guarantee|you will earn|easy money/i.test(w)), false);

done();
