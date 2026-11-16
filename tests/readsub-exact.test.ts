/**
 * A membership as Stripe holds it (lib/membership-numbers.ts, readSub) is read
 * in its exact shape (CX-123 rule 24; Claude 5's review of #3048, LOW 4).
 *
 * Its price, quantity, interval and interval count make what a member is
 * worth a month, shown to the creator as a fact. Absent or null reads as
 * before (a quantity of one, a month, a count of one); any other shape is
 * unknown and throws, never read as "a month", "one" or "nothing":
 *   - a quantity of 0 is worth nothing, never one at the full price;
 *   - an interval of 12, or a word that is not day, week, month or year, is
 *     never read as a month;
 *   - a count of 0, a negative or a fractional one is never read as one;
 *   - a price that is not a number is never read as free.
 * Synthetic data only.
 */
import { readSub } from "@/lib/membership-numbers";
import { done, is, part } from "./check";

const handles = new Set(["readsub"]);
type Item = Record<string, unknown>;
const raw = (item: Item = {}, price: Item = {}, recurring: Item = {}) => ({
  id: "sub_readsub1",
  status: "active",
  currency: "usd",
  start_date: 1_790_000_000,
  metadata: { store: "readsub", product: "p1" },
  items: { data: [{ quantity: 1, ...item, price: { unit_amount: 1500, ...price, recurring: { interval: "month", interval_count: 1, ...recurring } } }] },
});
const read = (r: ReturnType<typeof raw>) => {
  try {
    const sub = readSub(r as never, handles);
    return sub ? { amount: sub.amount, interval: sub.interval, count: sub.count } : null;
  } catch {
    return "unknown";
  }
};

part("Healthy and absent shapes read as before");
is("one at $15 a month", read(raw()), { amount: 1500, interval: "month", count: 1 });
is("two at $15 a year", read(raw({ quantity: 2 }, {}, { interval: "year" })), { amount: 3000, interval: "year", count: 1 });
is("every 3 weeks", read(raw({}, {}, { interval: "week", interval_count: 3 })), { amount: 1500, interval: "week", count: 3 });
is("no quantity (null): one", read(raw({ quantity: null })), { amount: 1500, interval: "month", count: 1 });
is("no interval or count (null): a month, once", read(raw({}, {}, { interval: null, interval_count: null })), { amount: 1500, interval: "month", count: 1 });
is("a quantity of 0 is worth nothing, never one at the full price", read(raw({ quantity: 0 })), { amount: 0, interval: "month", count: 1 });

part("Any other shape is unknown, never a month, one or nothing");
for (const [label, item, price, recurring] of [
  ["a negative quantity", { quantity: -1 }, {}, {}],
  ["a fractional quantity", { quantity: 1.5 }, {}, {}],
  ["a quantity in text", { quantity: "2" }, {}, {}],
  ["an interval of 12", {}, {}, { interval: 12 }],
  ["an interval that is no Stripe interval", {}, {}, { interval: "fortnight" }],
  ["an empty interval", {}, {}, { interval: "" }],
  ["a count of 0", {}, {}, { interval_count: 0 }],
  ["a negative count", {}, {}, { interval_count: -2 }],
  ["a fractional count", {}, {}, { interval_count: 1.5 }],
  ["a count in text", {}, {}, { interval_count: "2" }],
  ["a price in text", {}, { unit_amount: "1500" }, {}],
  ["a negative price", {}, { unit_amount: -1500 }, {}],
] as [string, Item, Item, Item][]) {
  is(`${label}: unknown`, read(raw(item, price, recurring)), "unknown");
}
part("A parent record in another shape is unknown, never free, one or a month (Codex Z on #3055)");
const withItems = (items: unknown) => ({ ...raw(), items });
const withItem = (item: unknown) => ({ ...raw(), items: { data: [item] } });
const withPrice = (price: unknown) => ({ ...raw(), items: { data: [{ quantity: 1, price }] } });
const withRecurring = (recurring: unknown) => ({ ...raw(), items: { data: [{ quantity: 1, price: { unit_amount: 1500, recurring } }] } });
for (const [label, r] of [
  ["the price in text", withPrice("price_1")],
  ["the price as a list", withPrice([1500])],
  ["the recurrence in text", withRecurring("year")],
  ["the recurrence as a list", withRecurring(["year"])],
  ["the item in text", withItem("si_1")],
  ["the item as a list", withItem([{ quantity: 1 }])],
  ["the items in text", withItems("items")],
  ["the items' list in text", withItems({ data: "si_1" })],
  ["the items' list as a record", withItems({ data: { 0: { quantity: 1 } } })],
] as [string, unknown][]) {
  is(`${label}: unknown`, read(r as never), "unknown");
}
is("no price at all (null) still reads as before: nothing", read(withPrice(null) as never), { amount: 0, interval: "month", count: 1 });
is("no recurrence at all (null) still reads as before: a month, once", read(withRecurring(null) as never), { amount: 1500, interval: "month", count: 1 });
is("no items at all still reads as before: nothing a month", read(withItems(undefined) as never), { amount: 0, interval: "month", count: 1 });
done();
