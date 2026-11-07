/**
 * 426 [BX2], unit 1: Claude 2's second money review of #2941 at fd4cd750
 * (comment 6702630564), each finding as a check on the rule
 * (lib/earnings-by-month.ts) or on the design the reading unit follows
 * (docs/bx2-earnings-design.md). Synthetic records only.
 *
 *   HIGH 1    a PayPal sale counted twice, once as "Stripe";
 *   MEDIUM 1  a reading without a whole kind (or without any list) was "read";
 *   MEDIUM 2  only subscription_cycle invoices: a paid upgrade disappeared;
 *   MEDIUM 3  PayPal's readers are not exact as they are (partial refunds never
 *             recorded, oldest-first cut, unreadable record dropped, unknown
 *             turned into 0, usd, now);
 *   MEDIUM 4  money given back (a dispute won, a refund that failed) had no way
 *             to be recorded in the month it came back;
 *   MEDIUM 5  a zone more than 14 hours ahead of UTC broke the month's floor;
 *   LOW 1     a record in year 10000, a reading outside four-digit years;
 *   LOW 2     the words of the number (tax collected from buyers).
 *
 * Then a pre-review of the fix at 925ae7d9ec, what was still open:
 *
 *   MEDIUM A  `notRead` took any kind, so a Stripe reading that said its
 *             renewals, refunds or disputes were never read still had a total
 *             (and every kind said left out was a confirmed zero); a total
 *             without disputes was still called "after refunds and disputes";
 *   MEDIUM B  money given back had no reading of its own (a dispute opened
 *             before `since` and won after it is never read);
 *   LOW 3     a record "stripe:paypal:…" passed as Stripe's own id;
 *   LOW 4     the design said the rule refuses a duplicate id across sources
 *             (an ES1 payment already in Stripe); it did not.
 *
 * Then Claude 2's focal return on #2941 at b9fa7aa7 (comment 6704822225):
 *
 *   MEDIUM C  the design's plan for unit 2 still said to reuse readPaidSales,
 *             readRenewals and the PayPal readers with their page caps, against
 *             its own table (never readPaidSales, every paid invoice but
 *             subscription_create, PayPal read in its exact shape);
 *   LOW 5     money given back read while the disputes it gives back were
 *             said not read was added: a sale of 1500, its dispute not read and
 *             the 1500 given back read made the year 3000, not 1500.
 */
import { readFileSync } from "node:fs";
import * as rule from "@/lib/earnings-by-month";
import {
  earningsByMonth,
  earningsMonths,
  monthFloor,
  readingSince,
  type EarningsInput,
  type ListReading,
  type MoneyKind,
  type ProviderReading,
} from "@/lib/earnings-by-month";
import { done, is, part } from "./check";

const AT = Date.UTC(2026, 10, 6, 12);
const SINCE = monthFloor("2025-12");
const utc = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h);
type Ev = { id?: string; at: number; cents: number; currency: string };
const list = (kind: MoneyKind, events: Ev[]): ListReading => ({ kind, events, since: SINCE, complete: true, reachedBack: null });
const input = (over: Partial<EarningsInput> = {}): EarningsInput => ({ at: AT, timeZone: "UTC", providers: [], manual: [], ...over });
type Out = ReturnType<typeof earningsByMonth>;
const month = (out: Out, key: string) => out!.months.find((m) => m.month === key)!;
const source = (out: Out, key: string, name: string) => month(out, key).sources.find((s) => s.source === name)! as {
  state: string;
  why?: string;
  lines?: { netCents: number; [field: string]: unknown }[];
  leftOut?: string[];
  partly?: string[];
};
/** Every kind a Stripe reading is read for, empty and complete, apart from those given. */
const fullStripe = (given: ListReading[], notRead: MoneyKind[] = []): ProviderReading => ({
  source: "stripe",
  lists: [...given, ...(["sale", "renewal", "refund", "dispute", "reinstated"] as MoneyKind[]).filter((k) => !given.some((l) => l.kind === k) && !notRead.includes(k)).map((k) => list(k, []))],
  ...(notRead.length ? { notRead } : {}),
});
const fullPayPal = (given: ListReading[]): ProviderReading => ({
  source: "paypal",
  lists: [...given, ...(["sale", "refund"] as MoneyKind[]).filter((k) => !given.some((l) => l.kind === k)).map((k) => list(k, []))],
  notRead: ["dispute"],
});
const doc = readFileSync("docs/bx2-earnings-design.md", "utf8");

part("HIGH 1: a PayPal sale is never counted twice, and never as Stripe");
{
  // readPaidSales (lib/stats.ts) adds the store's PayPal sales as rows of id `paypal:<order>`: a Stripe source built from it.
  // Money given back is said left out here, so the check reads the same on the rule before and after its new kind.
  const doubled = earningsByMonth(input({ providers: [
    fullStripe([list("sale", [{ id: "paypal:ORDER1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])], ["reinstated"]),
    fullPayPal([list("sale", [{ id: "paypal:sale:ORDER1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])]),
  ] }));
  is("a PayPal record given as Stripe makes Stripe unknown", [source(doubled, "2026-10", "stripe").state, source(doubled, "2026-10", "stripe").why], ["unknown", "invalid"]);
  is("and October has no total, never US$ 40", month(doubled, "2026-10").totals, null);
  const bare = earningsByMonth(input({ providers: [fullPayPal([list("sale", [{ id: "ORDER2", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])])] }));
  is("a PayPal record whose id does not say PayPal: unknown", source(bare, "2026-10", "paypal").state, "unknown");
  const noId = earningsByMonth(input({ providers: [fullStripe([list("sale", [{ at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])], ["reinstated"])] }));
  is("a provider record with no id cannot be checked for twice: unknown", source(noId, "2026-10", "stripe").state, "unknown");
  const once = earningsByMonth(input({ providers: [
    fullStripe([list("sale", [{ id: "stripe:cs_1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])], ["reinstated"]),
    fullPayPal([list("sale", [{ id: "paypal:sale:ORDER1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])]),
  ] }));
  is("control: a Stripe sale and a PayPal sale, each in its own source, are both read", month(once, "2026-10").totals?.map((l) => l.netCents), [4000]);
  is("the design never takes readPaidSales (which adds PayPal) as the Stripe reading", /\|\s*Checkouts, extras\s*\|\s*`readPaidSales`/.test(doc), false);
  is("and says why", doc.includes("adds the store's PayPal sales"), true);
}

part("MEDIUM 1: every kind a source has is read, said unread or said left out");
{
  const none = earningsByMonth(input({ providers: [{ source: "stripe", lists: [] }] }));
  is("Stripe with no list at all: unknown, never a confirmed zero", source(none, "2026-10", "stripe").state, "unknown");
  is("and no total", month(none, "2026-10").totals, null);
  const salesOnly = earningsByMonth(input({ providers: [{ source: "stripe", lists: [list("sale", [{ id: "stripe:cs_1", at: utc(2026, 10, 3), cents: 5000, currency: "usd" }])] }] }));
  is("Stripe with sales only (refunds, disputes never read): unknown", source(salesOnly, "2026-10", "stripe").state, "unknown");
  is("and October is not given as after refunds and disputes", month(salesOnly, "2026-10").totals, null);
  const noRefunds = earningsByMonth(input({ providers: [{ source: "paypal", lists: [list("sale", [{ id: "paypal:sale:O1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])], notRead: ["dispute"] }] }));
  is("PayPal with no refund list: unknown, refunds never a confirmed zero", source(noRefunds, "2026-10", "paypal").state, "unknown");
  const both = earningsByMonth(input({ providers: [{ ...fullPayPal([]), notRead: ["dispute", "refund"] }] }));
  is("a kind both read and said not read: unknown", source(both, "2026-10", "paypal").state, "unknown");
  const odd = earningsByMonth(input({ providers: [{ ...fullPayPal([]), notRead: ["dispute", "chargeback" as MoneyKind] }] }));
  is("a kind said not read that the rule does not know: unknown, never ignored", source(odd, "2026-10", "paypal").state, "unknown");
  const declared = earningsByMonth(input({ providers: [fullStripe([], ["reinstated"])] }));
  is("control: a kind said not read is read as left out", [source(declared, "2026-10", "stripe").state, source(declared, "2026-10", "stripe").leftOut], ["read", ["reinstated"]]);
  const all = earningsByMonth(input({ providers: [fullStripe([])] }));
  is("control: every kind read with nothing in it is a confirmed zero", [source(all, "2026-10", "stripe").state, month(all, "2026-10").totals], ["read", []]);
}

part("MEDIUM 2: every paid invoice of a membership counts, not only a period renewal");
is("the design reads upgrade and other invoices (subscription_update), not only subscription_cycle", doc.includes("`subscription_update`"), true);
is("and leaves out only the first invoice a checkout already counted (subscription_create)", doc.includes("`subscription_create`"), true);

part("MEDIUM 3: PayPal refunds are full refunds only, said on every PayPal month");
{
  const out = earningsByMonth(input({ providers: [fullPayPal([list("sale", [{ id: "paypal:sale:O1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])])] }));
  is("PayPal's refunds are read only in part", source(out, "2026-10", "paypal").partly, ["refund"]);
  is("the month says so", month(out, "2026-10").partly, [{ source: "paypal", kinds: ["refund"] }]);
  const s = earningsByMonth(input({ providers: [fullStripe([])] }));
  is("control: Stripe's refunds are read in full", source(s, "2026-10", "stripe").partly, []);
  is("the design no longer says PayPal's readers are reused as they are", doc.includes("reused as they are"), false);
  is("it says partial refunds are not recorded", doc.includes("partial refunds"), true);
  is("it says each PayPal list is read newest first", doc.includes("newest first, so a cut loses only the oldest"), true);
  // Rule 23: the title said "makes the list unread"; Claude 5's decision of 7 Nov 2026 is that such a record stops its list there.
  is("it says an unreadable record or a missing amount, currency or time never becomes 0, usd or now", doc.includes("never 0, `usd` or now"), true);
  is("it says such a record stops its list there, its month and the ones before it unknown", doc.includes("stops its list there") && doc.includes("every month that begins after it in every time zone"), true);
}

part("MEDIUM 4: money given back is its own amount, in the month it came back");
{
  const out = earningsByMonth(input({ providers: [fullStripe([
    list("sale", [{ id: "stripe:cs_1", at: utc(2026, 9, 20), cents: 1500, currency: "usd" }]),
    list("dispute", [{ id: "stripe:du_1", at: utc(2026, 10, 10), cents: 1500, currency: "usd" }]),
    list("reinstated", [{ id: "stripe:du_1:back", at: utc(2026, 11, 2), cents: 1500, currency: "usd" }]),
  ])] }));
  const net = (m: string) => {
    const s = source(out, m, "stripe");
    return s.state === "read" ? s.lines?.[0]?.netCents : `unknown (${s.why})`;
  };
  is("October keeps the money the bank took", net("2026-10"), -1500);
  is("November shows the money given back", net("2026-11"), 1500);
  is("as its own column", source(out, "2026-11", "stripe").lines?.[0]?.reinstatedCents, 1500);
  is("the design keeps a dispute in the month the bank took it, whatever its outcome", doc.includes("whatever happens to it later"), true);
}

part("MEDIUM 5: a zone where a month begins before its floor gives nothing");
{
  for (const zone of ["+23:00", "+14:01"]) {
    is(`${zone}: no months`, earningsMonths(AT, zone), []);
    is(`${zone}: no reading start`, Number.isNaN(readingSince(AT, zone)), true);
    is(`${zone}: nothing, never a month called read too soon`, earningsByMonth(input({ timeZone: zone, providers: [fullStripe([])] })), null);
  }
  for (const zone of ["Pacific/Kiritimati", "Etc/GMT-14", "+14:00", "-23:00", "Pacific/Pago_Pago"]) {
    is(`control: ${zone} has its twelve months`, earningsMonths(AT, zone).length, 12);
  }
}

part("LOW 1: year 10000 and years not of four digits (already closed with Codex J's Date-range siblings)");
{
  const far = earningsByMonth(input({ providers: [fullStripe([list("sale", [{ id: "stripe:cs_far", at: Date.UTC(10000, 0, 1), cents: 100, currency: "usd" }])])] }));
  is("a record in year 10000 makes its source unknown in every month", far!.months.every((m) => m.sources[0].state === "unknown"), true);
  for (const [what, at] of [["year 10000", Date.UTC(10000, 0, 15)], ["year 999", Date.UTC(999, 5, 15)]] as const) {
    is(`${what}: nothing, not an exception`, (() => { try { return earningsByMonth(input({ at })); } catch (error) { return `threw: ${(error as Error).message}`; } })(), null);
  }
}

part("LOW 2: what a sale's amount holds");
is("the design says sales include tax collected from buyers on top", doc.includes("tax collected from buyers"), true);

part("PRE-REVIEW A: only kinds a provider truly cannot read may be said left out, and the total says what it is after");
{
  const stripeSaid = (notRead: MoneyKind[]) => earningsByMonth(input({ providers: [{
    source: "stripe",
    lists: [list("sale", [{ id: "stripe:cs_1", at: utc(2026, 10, 3), cents: 5000, currency: "usd" }]), ...(["renewal", "refund", "dispute", "reinstated"] as MoneyKind[]).filter((k) => !notRead.includes(k)).map((k) => list(k, []))],
    notRead,
  }] }));
  // The proof of the pre-review, as it was (prerev-bx2-proof.test.ts, part A).
  const proof = stripeSaid(["renewal", "refund", "dispute", "reinstated"]);
  is("Stripe may not say its refunds and disputes are never read (only PayPal's disputes are)", source(proof, "2026-10", "stripe").state, "unknown");
  is("and October is not given a total 'after refunds and disputes'", month(proof, "2026-10").totals, null);
  const none = earningsByMonth(input({ providers: [{ source: "stripe", lists: [], notRead: ["sale", "renewal", "refund", "dispute", "reinstated"] }] }));
  is("Stripe with every kind said left out is not a confirmed zero", month(none, "2026-10").totals, null);
  // Each kind that must be read, alone.
  for (const kind of ["renewal", "refund"] as MoneyKind[]) {
    is(`Stripe saying its ${kind}s are not read: unknown, never a total`, [source(stripeSaid([kind]), "2026-10", "stripe").state, month(stripeSaid([kind]), "2026-10").totals], ["unknown", null]);
  }
  const noSales = earningsByMonth(input({ providers: [{ source: "stripe", lists: (["renewal", "refund", "dispute", "reinstated"] as MoneyKind[]).map((k) => list(k, [])), notRead: ["sale"] }] }));
  is("Stripe saying its sales are not read: unknown", source(noSales, "2026-10", "stripe").state, "unknown");
  for (const kind of ["sale", "refund"] as MoneyKind[]) {
    const out = earningsByMonth(input({ providers: [{ source: "paypal", lists: (["sale", "refund"] as MoneyKind[]).filter((k) => k !== kind).map((k) => list(k, [])), notRead: ["dispute", kind] }] }));
    is(`PayPal saying its ${kind}s are not read: unknown`, [source(out, "2026-10", "paypal").state, month(out, "2026-10").totals], ["unknown", null]);
  }
  const paypalBack = earningsByMonth(input({ providers: [{ ...fullPayPal([]), notRead: ["dispute", "reinstated"] }] }));
  is("PayPal saying a kind left out that it may not (money given back): unknown", source(paypalBack, "2026-10", "paypal").state, "unknown");
  // The year reading (claude5/bx2-u2-year-read-fix2) says Stripe disputes and money given back, and PayPal disputes, are not read.
  const year = earningsByMonth(input({ providers: [
    fullStripe([list("sale", [{ id: "stripe:cs_1", at: utc(2026, 10, 3), cents: 5000, currency: "usd" }]), list("refund", [{ id: "stripe:re_1", at: utc(2026, 10, 9), cents: 1000, currency: "usd" }])], ["dispute", "reinstated"]),
    fullPayPal([list("sale", [{ id: "paypal:sale:O1", at: utc(2026, 10, 4), cents: 2000, currency: "usd" }])]),
  ] }));
  const oct = month(year, "2026-10");
  is("control: the year reading's own sayings still give October a total", oct.totals?.map((l) => l.netCents), [6000]);
  is("and the month lists what it left out", oct.leftOut, [{ source: "stripe", kinds: ["dispute", "reinstated"] }, { source: "paypal", kinds: ["dispute"] }]);
  const words = (rule as Record<string, unknown>).netWords as ((sources: unknown) => string) | undefined;
  is("the rule says in words what a difference is after (netWords)", typeof words, "function");
  const said = typeof words === "function" ? words(oct.sources) : "";
  is("a total without disputes is never called after refunds and disputes", said.includes("and disputes"), false);
  is(
    "it says what was taken off and what was not",
    said,
    "After refunds, before disputes: Stripe and PayPal disputes are not read, so they are not taken off. Money given back by Stripe is not read, so it is not added. Partial PayPal refunds are not recorded, so they are not taken off.",
  );
  const all = earningsByMonth(input({ providers: [fullStripe([])] }));
  is("control: every kind read, the words are after refunds and disputes", typeof words === "function" ? words(month(all, "2026-10").sources) : "", "After refunds and disputes.");
  const some = earningsByMonth(input({ providers: [fullStripe([]), fullPayPal([])] }));
  is(
    "Stripe's disputes read, PayPal's not: it says whose disputes were taken off",
    typeof words === "function" ? words(month(some, "2026-10").sources) : "",
    "After refunds and Stripe disputes, before PayPal disputes, which are not read. Partial PayPal refunds are not recorded, so they are not taken off.",
  );
  is("the design no longer calls every difference after refunds and disputes", doc.includes('and the difference, called "after refunds and disputes"'), false);
  is("the design names the words the rule gives (netWords)", doc.includes("`netWords`"), true);
}

part("PRE-REVIEW B: money given back is said not read until it has a reading of its own");
is("the design says the year reading says money given back not read", doc.includes("says `reinstated` not read"), true);
is("and why: a dispute opened before the reading began and won after it is never read", doc.includes("opened before the reading began"), true);

part("PRE-REVIEW LOW 3: a record whose id holds another provider's prefix is not its source's own");
{
  // The proof of the pre-review, as it was (part B): readPaidSales's PayPal row prefixed again by a caller.
  const proof = earningsByMonth(input({ providers: [
    fullStripe([list("sale", [{ id: "stripe:paypal:ORDER1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])]),
    fullPayPal([list("sale", [{ id: "paypal:ORDER1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])]),
  ] }));
  is("October is never US$ 40", month(proof, "2026-10").totals, null);
  is("Stripe is the source refused", [source(proof, "2026-10", "stripe").state, source(proof, "2026-10", "paypal").state], ["unknown", "read"]);
  const upper = earningsByMonth(input({ providers: [fullStripe([list("sale", [{ id: "stripe:PayPal:ORDER1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])])] }));
  is("whatever its case", source(upper, "2026-10", "stripe").state, "unknown");
  const back = earningsByMonth(input({ providers: [fullPayPal([list("sale", [{ id: "paypal:stripe:pi_1", at: utc(2026, 10, 3), cents: 2000, currency: "usd" }])])] }));
  is("the same the other way (paypal:stripe:…)", source(back, "2026-10", "paypal").state, "unknown");
}

part("PRE-REVIEW LOW 4: the same id in two sources is refused, as the design says");
{
  // The proof of the pre-review, as it was (part C): an ES1 entry carrying a Stripe payment id already read.
  const proof = earningsByMonth(input({
    manual: [{ id: "stripe:pi_1", date: "2026-10-03", cents: 3000, currency: "usd" }],
    providers: [fullStripe([list("sale", [{ id: "stripe:pi_1", at: utc(2026, 10, 3), cents: 3000, currency: "usd" }])])],
  }));
  is("the same payment id in Stripe and in an entry is refused, never US$ 60", month(proof, "2026-10").totals, null);
  const apart = earningsByMonth(input({
    manual: [{ id: "stripe:pi_1", date: "2026-09-28", cents: 3000, currency: "usd" }],
    providers: [fullStripe([list("sale", [{ id: "stripe:pi_1", at: utc(2026, 10, 3), cents: 3000, currency: "usd" }])])],
  }));
  is("in two different months, neither month has a total", [month(apart, "2026-09").totals, month(apart, "2026-10").totals], [null, null]);
  is("a month without the id keeps its total", month(apart, "2026-08").totals, []);
  const other = earningsByMonth(input({
    manual: [{ id: "deal-1", date: "2026-10-03", cents: 3000, currency: "usd" }],
    providers: [fullStripe([list("sale", [{ id: "stripe:pi_1", at: utc(2026, 10, 3), cents: 3000, currency: "usd" }])])],
  }));
  is("control: different ids are both added", month(other, "2026-10").totals?.map((l) => l.netCents), [6000]);
  is("the design says the rule refuses the same id in two sources", doc.includes("the same id in two sources"), true);
}

part("FOCAL MEDIUM C: the design's plan for unit 2 says what its table says");
{
  const units = doc.slice(doc.indexOf("## Units, in order"));
  const second = units.slice(units.indexOf("2. **The year reading**"), units.indexOf("\n3. "));
  is("the plan is found", second.startsWith("2. **The year reading**"), true);
  is("it never reuses readPaidSales, readRenewals or the PayPal readers as they are", /reusing|the PayPal readers with their page caps|`readRenewals`, `readRefunds`/.test(second), false);
  is("it takes every paid invoice but subscription_create, as the table does", second.includes("subscription_create"), true);
  is("the reading section no longer says the same functions", doc.includes("the same functions with the same page caps"), false);
}

part("FOCAL LOW 5: money given back is never added while the disputes it gives back are not read");
{
  // Claude 2's proof (c2-2941-back-alone, 0/2 at b9fa7aa7): a sale of 1500, its dispute not read, the 1500 given back read.
  const sale = list("sale", [{ id: "stripe:cs_1", at: utc(2026, 9, 20), cents: 1500, currency: "usd" }]);
  const back = list("reinstated", [{ id: "stripe:du_1:back", at: utc(2026, 11, 2), cents: 1500, currency: "usd" }]);
  const proof = earningsByMonth(input({ providers: [fullStripe([sale, back], ["dispute"])] }));
  const nov = source(proof, "2026-11", "stripe");
  is(
    "November is not +1500 'read' beside disputes not read",
    nov.state === "unknown" || (nov.state === "read" && (nov.lines ?? []).every((l) => l.reinstatedCents === 0) && (nov.leftOut ?? []).includes("reinstated")),
    true,
  );
  const year = proof!.months.every((m) => m.totals) ? proof!.months.reduce((sum, m) => sum + m.totals!.reduce((t, l) => t + l.netCents, 0), 0) : null;
  is("and the year never adds to 3000", year === 3000, false);
  is("Stripe's reading is refused, never trimmed", [nov.state, nov.why], ["unknown", "invalid"]);
  const empty = earningsByMonth(input({ providers: [fullStripe([sale], ["dispute"])] }));
  is("even an empty list of money given back, beside disputes not read", source(empty, "2026-11", "stripe").state, "unknown");
  // Sibling: PayPal always says its disputes are not read, so a PayPal list of money given back is refused too.
  const paypal = earningsByMonth(input({ providers: [fullPayPal([list("reinstated", [{ id: "paypal:back:O1", at: utc(2026, 11, 2), cents: 1500, currency: "usd" }])])] }));
  is("PayPal's money given back beside its disputes not read: unknown", [source(paypal, "2026-11", "paypal").state, month(paypal, "2026-11").totals], ["unknown", null]);
  const both = earningsByMonth(input({ providers: [fullStripe([sale], ["dispute", "reinstated"])] }));
  is("control: both said not read, the months are read", [source(both, "2026-11", "stripe").state, month(both, "2026-09").totals?.map((l) => l.netCents)], ["read", [1500]]);
  const read = earningsByMonth(input({ providers: [fullStripe([sale, back, list("dispute", [{ id: "stripe:du_1", at: utc(2026, 10, 10), cents: 1500, currency: "usd" }])])] }));
  is("control: both read, the year is the real 1500", read!.months.reduce((sum, m) => sum + (m.totals ?? []).reduce((t, l) => t + l.netCents, 0), 0), 1500);
}

done();
