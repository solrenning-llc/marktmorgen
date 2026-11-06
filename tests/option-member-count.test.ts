/**
 * 642 [WG2], unit 2a: how many live members are on one price option, read from
 * the membership reading the studio already makes (lib/membership-numbers.ts),
 * never by a Stripe call of its own. What is checked:
 *
 *   - a membership keeps the option it was bought at (metadata[option]);
 *   - live members (paying, in a trial or with a failed payment being
 *     retried) are counted per option; ended and cancelled ones are not, nor
 *     ones on the product's own price or moved to another tier (option "");
 *   - an unknown count is said as unknown, never 0: no reading, a reading
 *     that did not read every membership, or one from before this counting.
 */
import { membersOnOption, numbersFrom, readSub, type Numbers, type Sub } from "@/lib/membership-numbers";
import { done, is, part } from "./check";

const NOW = 1_800_000_000;
const handles = new Set(["clubhouse"]);
const raw = (id: string, status: string, option: string | undefined, product = "club1") => ({
  id,
  object: "subscription",
  status,
  currency: "usd",
  start_date: NOW - 40 * 86_400,
  ended_at: status === "canceled" ? NOW - 86_400 : null,
  metadata: { store: "clubhouse", product, ...(option === undefined ? {} : { option }) },
  items: { data: [{ quantity: 1, price: { unit_amount: 1500, recurring: { interval: "month", interval_count: 1 } } }] },
});

part("A membership keeps the option it was bought at");
const one = readSub(raw("sub_a", "active", "basic") as never, handles);
is("read from metadata[option]", one?.option, "basic");
is("none on the product's own price, nor on a tier switch's empty option", [readSub(raw("sub_b", "active", undefined) as never, handles)?.option, readSub(raw("sub_c", "active", "") as never, handles)?.option], [undefined, undefined]);

part("Live members counted per option");
const subs = [
  raw("s1", "active", "basic"),
  raw("s2", "trialing", "basic"),
  raw("s3", "past_due", "basic"),
  raw("s4", "canceled", "basic"),
  raw("s5", "incomplete_expired", "basic"),
  raw("s6", "active", "plus"),
  raw("s7", "active", undefined),
  raw("s8", "active", ""),
  raw("s9", "active", "basic", "other1"),
].map((entry) => readSub(entry as never, handles)).filter((sub): sub is Sub => sub !== null);
const numbers = numbersFrom(subs, "usd", NOW, true);
is("basic: active, in a trial and retrying count; ended ones do not", membersOnOption(numbers, "club1", "basic"), 3);
is("plus: one", membersOnOption(numbers, "club1", "plus"), 1);
is("an option nobody is on: 0, said as a count", membersOnOption(numbers, "club1", "gold"), 0);
is("another product's members on an option of the same id are not counted here", membersOnOption(numbers, "other1", "basic"), 1);
is("the product's totals are as before", numbers.byProduct.find((row) => row.product === "club1") && [numbers.byProduct.find((row) => row.product === "club1")!.members, numbers.byProduct.find((row) => row.product === "club1")!.trialing], [5, 1]);

part("Unknown is unknown, never 0");
is("no reading", membersOnOption(null, "club1", "basic"), null);
is("a reading that did not read every membership", membersOnOption(numbersFrom(subs, "usd", NOW, false), "club1", "basic"), null);
const old = { ...numbers } as Numbers;
delete (old as { optionsCounted?: true }).optionsCounted;
is("a reading kept from before options were counted", membersOnOption(old, "club1", "basic"), null);


part("A kept reading is read in its exact shape: anything odd is unknown, never 0 (Codex T on #2690)");
const shaped = (change: (copy: Record<string, unknown>) => void): Numbers => {
  const copy = JSON.parse(JSON.stringify(numbers)) as Record<string, unknown>;
  change(copy);
  return copy as unknown as Numbers;
};
const club = (copy: Record<string, unknown>) => (copy.byProduct as Record<string, unknown>[]).find((row) => row.product === "club1")!;
const odd: [string, Numbers][] = [
  ["complete as text \"false\"", shaped((c) => { c.complete = "false"; })],
  ["complete as 1", shaped((c) => { c.complete = 1; })],
  ["optionsCounted as 1", shaped((c) => { c.optionsCounted = 1; })],
  ["a null count", shaped((c) => { (club(c).byOption as Record<string, unknown>).basic = null; })],
  ["a count as text", shaped((c) => { (club(c).byOption as Record<string, unknown>).basic = "3"; })],
  ["a negative count", shaped((c) => { (club(c).byOption as Record<string, unknown>).basic = -1; })],
  ["a fractional count", shaped((c) => { (club(c).byOption as Record<string, unknown>).basic = 1.5; })],
  ["the table as a number", shaped((c) => { club(c).byOption = 7; })],
  ["the table as a list", shaped((c) => { club(c).byOption = [3]; })],
  ["the table as null", shaped((c) => { club(c).byOption = null; })],
  ["byProduct not a list", shaped((c) => { c.byProduct = { club1: club(c) }; })],
  ["a row that is not an object", shaped((c) => { (c.byProduct as unknown[]).push(5); })],
  ["the product's row twice", shaped((c) => { (c.byProduct as unknown[]).push({ ...club(c) }); })],
];
for (const [name, reading] of odd) is(`${name}: unknown`, membersOnOption(reading, "club1", "basic"), null);
let gets = 0;
const sneaky = shaped((c) => { club(c).byOption = Object.defineProperty({}, "basic", { enumerable: true, get: () => ((gets += 1), 3) }); });
is("a getter in the table is never called and is unknown", [membersOnOption(sneaky, "club1", "basic"), gets], [null, 0]);
Object.defineProperty(Object.prototype, "inherited", { value: 9, configurable: true });
is("a count inherited from Object.prototype is not a count: the option is not in the table, so 0 from the whole reading", membersOnOption(numbers, "club1", "inherited"), 0);
delete (Object.prototype as Record<string, unknown>).inherited;
is("a product with no row in a whole reading: 0, proved by the reading", membersOnOption(numbers, "nobody1", "basic"), 0);
is("a row without a table in a whole reading: 0 (nobody on any of its options)", membersOnOption(shaped((c) => { delete club(c).byOption; }), "club1", "basic"), 0);
done();
