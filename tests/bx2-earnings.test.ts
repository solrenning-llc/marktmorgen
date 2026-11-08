/**
 * 426 [BX2], unit 1: the rule that puts a store's earnings into months and
 * sources (lib/earnings-by-month.ts; docs/bx2-earnings-design.md). Months are
 * calendar months in the store's time zone; sources are kept apart with their
 * provenance; currencies are never added together; refunds and disputes are
 * taken off; a month a source could not be read in full is unknown, never a
 * lower number and never zero; a month read in full with nothing in it is a
 * confirmed zero; and nothing in the output ranks or rates the creator by
 * revenue (561 [NE1]). Pure: synthetic records only.
 */
import {
  EARNINGS_MONTHS,
  EXPECTED_KINDS,
  SOURCE_WORDS,
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

const AT = Date.UTC(2026, 10, 6, 12, 0, 0); // 6 November 2026, 12:00 UTC
const utc = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h);
const FLOOR_OLDEST = Date.UTC(2025, 11, 1) - 14 * 3600_000;

const list = (kind: MoneyKind, events: { id?: string; at: number; cents: number; currency: string }[], over: Partial<{ complete: boolean; reachedBack: number | null; since: number }> = {}): ListReading => ({
  kind,
  events,
  since: over.since ?? FLOOR_OLDEST,
  complete: over.complete ?? true,
  reachedBack: over.reachedBack ?? null,
});
/**
 * A provider's reading as the rule takes it since Claude 2's review of #2941 (rule 23: the fixtures changed, not
 * what is asserted): each record's id carries its provider ("stripe:…", "paypal:…"), and every kind the provider has
 * that a check does not give is an empty complete list, so each check still reads only the lists it is about.
 */
const provider = (name: "stripe" | "paypal", lists: ListReading[], notRead: MoneyKind[] = []): ProviderReading => ({
  source: name,
  lists: [
    ...lists.map((l) => ("unread" in l ? l : { ...l, events: l.events.map((e) => (typeof e.id === "string" ? { ...e, id: `${name}:${e.id}` } : e)) })),
    ...EXPECTED_KINDS[name].filter((k) => !lists.some((l) => l.kind === k) && !notRead.includes(k)).map((k) => list(k, [])),
  ],
  ...(notRead.length ? { notRead } : {}),
});
const stripe = (lists: ListReading[]): ProviderReading => provider("stripe", lists);
const input = (over: Partial<EarningsInput> = {}): EarningsInput => ({ at: AT, timeZone: "UTC", providers: [], manual: [], ...over });
const month = (out: ReturnType<typeof earningsByMonth>, key: string) => out!.months.find((m) => m.month === key)!;
const source = (out: ReturnType<typeof earningsByMonth>, key: string, name: string) => month(out, key).sources.find((s) => s.source === name)!;

part("Twelve calendar months, newest first, in the store's time zone");
is("the count", EARNINGS_MONTHS, 12);
is("months from 6 November 2026 in UTC", earningsMonths(AT, "UTC"), [
  "2026-11", "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01", "2025-12",
]);
is("on 1 November 01:00 UTC, São Paulo is still in October", earningsMonths(Date.UTC(2026, 10, 1, 1), "America/Sao_Paulo")[0], "2026-10");
is("on 31 October 16:00 UTC, Tokyo is already in November", earningsMonths(Date.UTC(2026, 9, 31, 16), "Asia/Tokyo")[0], "2026-11");
is("a month's floor: UTC midnight of the 1st less 14 hours, before any zone's midnight", monthFloor("2025-12"), FLOOR_OLDEST);
is("the reading starts at the oldest month's floor", readingSince(AT, "UTC"), FLOOR_OLDEST);
is("an unknown time zone gives nothing, never UTC in its place", earningsByMonth(input({ timeZone: "Mars/Olympus" })), null);
is("a bad reading time gives nothing", earningsByMonth(input({ at: Number.NaN })), null);

part("An event falls in the month of its own zone");
{
  const edge = Date.UTC(2026, 10, 1, 2); // 1 November 02:00 UTC = 31 October 23:00 in São Paulo
  const events = [{ id: "cs_1", at: edge, cents: 5000, currency: "usd" }];
  const inUtc = earningsByMonth(input({ providers: [stripe([list("sale", events)])] }));
  const inSaoPaulo = earningsByMonth(input({ timeZone: "America/Sao_Paulo", providers: [stripe([list("sale", events)])] }));
  is("UTC: November", (source(inUtc, "2026-11", "stripe") as { lines: unknown[] }).lines.length, 1);
  is("São Paulo: October", (source(inSaoPaulo, "2026-10", "stripe") as { lines: { salesCents: number }[] }).lines[0].salesCents, 5000);
  is("São Paulo: nothing in November", (source(inSaoPaulo, "2026-11", "stripe") as { lines: unknown[] }).lines, []);
}

part("Refunds and disputes are taken off, in the month they were recorded");
{
  const out = earningsByMonth(input({
    providers: [stripe([
      list("sale", [{ id: "cs_1", at: utc(2026, 10, 3), cents: 5000, currency: "usd" }, { id: "cs_2", at: utc(2026, 10, 9), cents: 2500, currency: "usd" }]),
      list("sale", [{ id: "pi_x", at: utc(2026, 10, 3, 13), cents: 900, currency: "usd" }]),
      list("renewal", [{ id: "in_1", at: utc(2026, 10, 20), cents: 1500, currency: "usd" }]),
      list("refund", [{ id: "re_1", at: utc(2026, 10, 10), cents: 1000, currency: "usd" }, { id: "re_2", at: utc(2026, 11, 2), cents: 2500, currency: "usd" }]),
      list("dispute", [{ id: "du_1", at: utc(2026, 10, 15), cents: 500, currency: "usd" }]),
    ])],
  }));
  // Rule 23 (Claude 2 on #2941, MEDIUM 4): every line gained reinstatedCents (money given back), 0 here and below;
  // no amount asserted in this file changed.
  is("October, every part and the difference", (source(out, "2026-10", "stripe") as { lines: unknown[] }).lines, [
    { currency: "usd", salesCents: 8400, renewalCents: 1500, enteredCents: 0, refundCents: 1000, disputeCents: 500, reinstatedCents: 0, netCents: 8400 },
  ]);
  is("a refund in November of an October sale makes November negative, as it was", (source(out, "2026-11", "stripe") as { lines: unknown[] }).lines, [
    { currency: "usd", salesCents: 0, renewalCents: 0, enteredCents: 0, refundCents: 2500, disputeCents: 0, reinstatedCents: 0, netCents: -2500 },
  ]);
  is("the month's total", month(out, "2026-10").totals, [
    { currency: "usd", salesCents: 8400, renewalCents: 1500, enteredCents: 0, refundCents: 1000, disputeCents: 500, reinstatedCents: 0, netCents: 8400 },
  ]);
}

part("Currencies are never added together");
{
  const out = earningsByMonth(input({
    providers: [stripe([list("sale", [{ id: "a", at: utc(2026, 9, 2), cents: 1000, currency: "usd" }, { id: "b", at: utc(2026, 9, 3), cents: 700, currency: "EUR" }])])],
    manual: [{ id: "m1", date: "2026-09-20", cents: 30000, currency: "usd" }],
  }));
  const line = (currency: string) => month(out, "2026-09").totals!.find((l) => l.currency === currency)!.netCents;
  is("one line a currency, alphabetical", month(out, "2026-09").totals!.map((l) => l.currency), ["eur", "usd"]);
  is("euros alone", line("eur"), 700);
  is("dollars: Stripe and entered by you, same currency", line("usd"), 31000);
}

part("Entered by you: its own source, never verified, by the date typed");
{
  const out = earningsByMonth(input({ manual: [{ id: "m1", date: "2026-07-31", cents: 12000, currency: "usd" }, { id: "m2", date: "2026-08-01", cents: 500, currency: "gbp" }] }));
  is("the words for each source", SOURCE_WORDS, { stripe: "Stripe", paypal: "PayPal", manual: "Entered by you" });
  is("July", (source(out, "2026-07", "manual") as { lines: unknown[] }).lines, [{ currency: "usd", salesCents: 0, renewalCents: 0, enteredCents: 12000, refundCents: 0, disputeCents: 0, reinstatedCents: 0, netCents: 12000 }]);
  is("August, in pounds", (source(out, "2026-08", "manual") as { lines: { currency: string }[] }).lines[0].currency, "gbp");
  const unread = earningsByMonth(input({ manual: null }));
  is("entries that could not be read are unknown in every month", unread!.months.every((m) => m.sources.find((s) => s.source === "manual")!.state === "unknown"), true);
  is("and the months' totals are not shown", unread!.months.every((m) => m.totals === null), true);
  for (const [what, entry] of [
    ["a date that does not exist", { id: "m", date: "2026-02-30", cents: 100, currency: "usd" }],
    ["a date in a month to come", { id: "m", date: "2026-12-01", cents: 100, currency: "usd" }],
    ["no amount", { id: "m", date: "2026-10-01", cents: 0, currency: "usd" }],
    ["a fraction of a cent", { id: "m", date: "2026-10-01", cents: 1.5, currency: "usd" }],
    ["no currency", { id: "m", date: "2026-10-01", cents: 100, currency: "" }],
  ] as const) {
    const bad = earningsByMonth(input({ manual: [entry] }));
    is(`${what}: unknown, never left out quietly`, source(bad, "2026-10", "manual"), { source: "manual", state: "unknown", why: "invalid" });
  }
  const twice = earningsByMonth(input({ manual: [{ id: "m", date: "2026-10-01", cents: 100, currency: "usd" }, { id: "m", date: "2026-10-02", cents: 100, currency: "usd" }] }));
  is("the same entry twice is unknown, never counted twice", source(twice, "2026-10", "manual"), { source: "manual", state: "unknown", why: "invalid" });
  is("an entry before the twelve months is outside them, not an error", (source(earningsByMonth(input({ manual: [{ id: "m", date: "2025-11-30", cents: 100, currency: "usd" }] })), "2025-12", "manual") as { state: string }).state, "read");
}

part("A source that could not be read is unknown, never zero");
{
  const out = earningsByMonth(input({
    providers: [stripe([list("sale", [{ id: "cs_1", at: utc(2026, 10, 3), cents: 5000, currency: "usd" }]), { kind: "refund", unread: true }])],
    manual: [{ id: "m1", date: "2026-10-05", cents: 100, currency: "usd" }],
  }));
  is("every month of Stripe says why", out!.months.map((m) => m.sources.find((s) => s.source === "stripe")).every((s) => JSON.stringify(s) === JSON.stringify({ source: "stripe", state: "unknown", why: "unread" })), true);
  is("no total is shown for a month with a source unknown", month(out, "2026-10").totals, null);
  is("what was read is still shown, as its own source", (source(out, "2026-10", "manual") as { lines: { enteredCents: number }[] }).lines[0].enteredCents, 100);
}

part("A capped list proves only the months it reached");
{
  const reached = utc(2026, 8, 14); // the oldest record read: 14 August
  const out = earningsByMonth(input({ providers: [stripe([list("sale", [{ id: "cs_9", at: utc(2026, 9, 1), cents: 100, currency: "usd" }, { id: "cs_8", at: reached, cents: 100, currency: "usd" }], { complete: false, reachedBack: reached })])] }));
  is("September to November are read", ["2026-11", "2026-10", "2026-09"].map((k) => (source(out, k, "stripe") as { state: string }).state), ["read", "read", "read"]);
  is("August, half read, is not shown as a lower number", source(out, "2026-08", "stripe"), { source: "stripe", state: "unknown", why: "not_reached" });
  is("nor any month before it", (source(out, "2025-12", "stripe") as { state: string }).state, "unknown");
  const floor = monthFloor("2026-09");
  const at = (back: number) => (source(earningsByMonth(input({ providers: [stripe([list("sale", [], { complete: false, reachedBack: back })])] })), "2026-09", "stripe") as { state: string }).state;
  is("reached exactly at the floor: a record of the same second may be next, so unknown", at(floor), "unknown");
  is("reached a millisecond before the floor: read", at(floor - 1), "read");
  is("capped with nothing reached: unknown everywhere", (source(earningsByMonth(input({ providers: [stripe([list("sale", [], { complete: false, reachedBack: null })])] })), "2026-11", "stripe") as { state: string }).state, "unknown");
  const late = earningsByMonth(input({ providers: [stripe([list("sale", [], { complete: true, since: monthFloor("2026-06") })])] }));
  is("a complete list that started later proves only from its start", [(source(late, "2026-06", "stripe") as { state: string }).state, (source(late, "2026-05", "stripe") as { state: string }).state], ["read", "unknown"]);
}

part("A record that cannot be understood makes its source unknown");
for (const [what, event] of [
  ["a negative amount", { id: "x", at: utc(2026, 10, 1), cents: -1, currency: "usd" }],
  ["an amount that is not whole", { id: "x", at: utc(2026, 10, 1), cents: 10.5, currency: "usd" }],
  ["a currency that is not three letters", { id: "x", at: utc(2026, 10, 1), cents: 100, currency: "US" }],
  ["no time", { id: "x", at: Number.NaN, cents: 100, currency: "usd" }],
  ["a time in a month to come", { id: "x", at: utc(2026, 12, 2), cents: 100, currency: "usd" }],
] as const) {
  const out = earningsByMonth(input({ providers: [stripe([list("sale", [event])])] }));
  is(`${what}: unknown in every month`, out!.months.every((m) => m.sources[0].state === "unknown" && (m.sources[0] as { why: string }).why === "invalid"), true);
}
{
  const twice = earningsByMonth(input({ providers: [stripe([list("sale", [{ id: "cs_1", at: utc(2026, 10, 1), cents: 100, currency: "usd" }]), list("sale", [{ id: "cs_1", at: utc(2026, 10, 1), cents: 100, currency: "usd" }])])] }));
  is("the same record twice is unknown, never counted twice", source(twice, "2026-10", "stripe"), { source: "stripe", state: "unknown", why: "invalid" });
  const old = earningsByMonth(input({ providers: [stripe([list("sale", [{ id: "cs_0", at: utc(2025, 11, 30), cents: 100, currency: "usd" }])])] }));
  is("a record before the twelve months (read for the oldest month's floor) is left out, not an error", (source(old, "2025-12", "stripe") as { lines: unknown[] }).lines, []);
  const huge = earningsByMonth(input({ providers: [stripe([list("sale", [{ id: "a", at: utc(2026, 10, 1), cents: Number.MAX_SAFE_INTEGER, currency: "usd" }, { id: "b", at: utc(2026, 10, 2), cents: 10, currency: "usd" }])])] }));
  is("a sum past exact integers is unknown, never rounded", source(huge, "2026-10", "stripe"), { source: "stripe", state: "unknown", why: "too_large" });
}

part("Codex J's review of #2941 (5808632896; proof codex/j-review-2941-earnings@fee674d4): exact sums, one wrapper a source, Date range, the reading's horizon");
{
  const max = Number.MAX_SAFE_INTEGER;
  // MEDIUM 1: a net computed past exact integers came back one cent short yet safe, and was shown as read.
  const wide = earningsByMonth(input({ providers: [stripe([
    list("sale", [{ id: "s", at: utc(2026, 10, 1), cents: max, currency: "usd" }]),
    list("renewal", [{ id: "n", at: utc(2026, 10, 2), cents: 2, currency: "usd" }]),
    list("refund", [{ id: "r", at: utc(2026, 10, 3), cents: 2, currency: "usd" }]),
  ])] }));
  const wideMonth = source(wide, "2026-10", "stripe") as { state: string; lines?: { netCents: number }[]; why?: string };
  is("money in past exact integers, then out: the net is exact, never a cent off", wideMonth.state === "read" ? wideMonth.lines![0].netCents : wideMonth.why, max);
  const across = earningsByMonth(input({
    providers: [stripe([list("sale", [{ id: "s", at: utc(2026, 10, 1), cents: max, currency: "usd" }]), list("refund", [{ id: "r", at: utc(2026, 10, 2), cents: 2, currency: "usd" }])])],
    manual: [{ id: "m", date: "2026-10-05", cents: 2, currency: "usd" }],
  }));
  is("Stripe's net is exact (max - 2)", (source(across, "2026-10", "stripe") as { lines: { netCents: number }[] }).lines[0].netCents, max - 2);
  is("the month's total across sources is exact too, never a cent off", month(across, "2026-10").totals, [
    { currency: "usd", salesCents: max, renewalCents: 0, enteredCents: 2, refundCents: 2, disputeCents: 0, reinstatedCents: 0, netCents: max },
  ]);
  const exactNet = earningsByMonth(input({ providers: [stripe([
    list("sale", [{ id: "s", at: utc(2026, 10, 1), cents: max - 4, currency: "usd" }]),
    list("renewal", [{ id: "n", at: utc(2026, 10, 2), cents: 2, currency: "usd" }]),
    list("refund", [{ id: "r", at: utc(2026, 10, 3), cents: 2, currency: "usd" }]),
  ])] }));
  is("control: within exact integers the net is exact", (source(exactNet, "2026-10", "stripe") as { lines: { netCents: number }[] }).lines[0].netCents, max - 4);

  // MEDIUM 2: two wrappers of the same provider each had their own seen ids, so one Stripe payment counted twice.
  const sale = { id: "same", at: utc(2026, 10, 1), cents: 200, currency: "usd" };
  const doubled = earningsByMonth(input({ providers: [stripe([list("sale", [sale])]), stripe([list("sale", [sale])])] }));
  is("one source, said once", month(doubled, "2026-10").sources.map((s) => s.source), ["stripe", "manual"]);
  is("a provider given twice is unknown, never added twice", source(doubled, "2026-10", "stripe"), { source: "stripe", state: "unknown", why: "invalid" });
  is("and the month has no total", month(doubled, "2026-10").totals, null);
  const twoIds = earningsByMonth(input({ providers: [stripe([list("sale", [sale])]), stripe([list("sale", [{ ...sale, id: "other" }])])] }));
  is("even with different records, a provider given twice is unknown (rule 30)", (source(twoIds, "2026-10", "stripe") as { state: string }).state, "unknown");
  const paypalTwice = earningsByMonth(input({ providers: [{ source: "paypal", lists: [list("sale", [])] }, { source: "paypal", lists: [list("sale", [])] }] }));
  is("PayPal given twice is unknown too", (source(paypalTwice, "2026-10", "paypal") as { state: string }).state, "unknown");
  is("a provider that is not Stripe or PayPal gives nothing, never a total", earningsByMonth(input({ providers: [{ source: "manual" as "stripe", lists: [list("sale", [sale])] }] })), null);
  // Rule 23 (Claude 2 on #2941, HIGH 1 and MEDIUM 1): PayPal given with its own ids and every kind; same assertion.
  const both = earningsByMonth(input({ providers: [stripe([list("sale", [sale])]), provider("paypal", [list("sale", [{ ...sale, id: "pp" }])], ["dispute"])] }));
  is("control: Stripe and PayPal once each are both read", month(both, "2026-10").totals!.map((l) => l.netCents), [400]);

  // LOW 3: a finite time outside Date's range reached Intl and threw.
  is("a reading time outside Date's range gives nothing, never a throw", (() => { try { return earningsByMonth(input({ at: max })); } catch (error) { return String(error); } })(), null);
  is("and no months for it", (() => { try { return earningsMonths(-max, "UTC"); } catch (error) { return String(error); } })(), []);
  for (const at of [max, -max]) {
    const out = (() => { try { return earningsByMonth(input({ providers: [stripe([list("sale", [{ id: "d", at, cents: 100, currency: "usd" }])])] })); } catch (error) { return String(error); } })();
    is(`a record at ${at > 0 ? "+" : "-"}MAX_SAFE_INTEGER ms: its source unknown, never a throw`, typeof out === "string" ? out : source(out, "2026-10", "stripe"), { source: "stripe", state: "unknown", why: "invalid" });
  }

  // Rule 30 siblings of LOW 3: a time inside Date's range whose year is not four digits.
  const bc = Date.UTC(2026, 10, 3) - Date.UTC(2026, 0, 1) + Date.UTC(-2025, 0, 1); // 3 November of 2026 BC (proleptic year -2025)
  const ancient = earningsByMonth(input({ providers: [stripe([list("sale", [{ id: "bc", at: bc, cents: 100, currency: "usd" }])])] }));
  is("a record from 2026 BC is before every month shown, never counted in November 2026", (source(ancient, "2026-11", "stripe") as { lines: unknown[] }).lines, []);
  is("a reading in year 1 gives nothing, never a throw", (() => { try { return earningsByMonth(input({ at: new Date(0).setUTCFullYear(1, 0, 15) })); } catch (error) { return String(error); } })(), null);
  is("a reading in year 10000 gives nothing, never a throw", (() => { try { return earningsByMonth(input({ at: Date.UTC(10000, 0, 15) })); } catch (error) { return String(error); } })(), null);

  // LOW 4: the current month runs to the reading's time; a record after it is not money "so far".
  const after = earningsByMonth(input({ providers: [stripe([list("sale", [{ id: "a", at: AT + 1, cents: 200, currency: "usd" }])])] }));
  is("a record a millisecond after the reading: its source unknown", source(after, "2026-11", "stripe"), { source: "stripe", state: "unknown", why: "invalid" });
  const atReading = earningsByMonth(input({ providers: [stripe([list("sale", [{ id: "a", at: AT, cents: 200, currency: "usd" }])])] }));
  is("control: a record at the reading's own time is read", (source(atReading, "2026-11", "stripe") as { lines: { salesCents: number }[] }).lines[0].salesCents, 200);
  const tomorrow = earningsByMonth(input({ manual: [{ id: "f", date: "2026-11-07", cents: 200, currency: "usd" }] }));
  is("an entry dated the day after the reading: unknown", source(tomorrow, "2026-11", "manual"), { source: "manual", state: "unknown", why: "invalid" });
  const today = earningsByMonth(input({ manual: [{ id: "t", date: "2026-11-06", cents: 200, currency: "usd" }] }));
  is("control: an entry dated the reading's own day is read", (source(today, "2026-11", "manual") as { state: string }).state, "read");
  const tokyo = earningsByMonth(input({ timeZone: "Asia/Tokyo", at: Date.UTC(2026, 10, 6, 16), manual: [{ id: "t", date: "2026-11-07", cents: 200, currency: "usd" }] }));
  is("control: the reading's day is the store's own (16:00 UTC on the 6th is the 7th in Tokyo)", (source(tokyo, "2026-11", "manual") as { state: string }).state, "read");
}

part("A month read in full with nothing in it is a confirmed zero");
{
  const out = earningsByMonth(input({ providers: [stripe([list("sale", []), list("refund", [])])] }));
  // Rule 23 (Claude 2 on #2941, MEDIUM 3): a read source also says the kinds read only in part; Stripe has none.
  is("read, with no line", source(out, "2026-03", "stripe"), { source: "stripe", state: "read", lines: [], leftOut: [], partly: [] });
  is("and an empty total, not an unknown one", month(out, "2026-03").totals, []);
}

part("PayPal disputes are not read: said, not hidden");
{
  const paypal = provider("paypal", [list("sale", [{ id: "pp_1", at: utc(2026, 10, 4), cents: 2000, currency: "usd" }]), list("refund", [])], ["dispute"]);
  const out = earningsByMonth(input({ providers: [paypal] }));
  is("read, with disputes left out", (source(out, "2026-10", "paypal") as { leftOut: string[] }).leftOut, ["dispute"]);
  is("the month says so too", month(out, "2026-10").leftOut, [{ source: "paypal", kinds: ["dispute"] }]);
}

part("Nothing ranks or rates the creator by revenue (561 [NE1])");
{
  const out = earningsByMonth(input({ providers: [stripe([list("sale", [{ id: "cs_1", at: utc(2026, 10, 3), cents: 5000, currency: "usd" }])])] }));
  is("the output's fields", Object.keys(out!).sort(), ["at", "months", "since", "timeZone"]);
  // Rule 23 (Claude 2 on #2941, MEDIUM 3): `partly` beside `leftOut`; still no ranking or status field.
  is("a month's fields", Object.keys(month(out, "2026-10")).sort(), ["current", "leftOut", "month", "partly", "sources", "totals"]);
  is("only the newest month is the current one", out!.months.map((m) => m.current), [true, false, false, false, false, false, false, false, false, false, false, false]);
}

done();
