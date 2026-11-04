/**
 * Several lengths for one call, each with its own price (637 [GL5], unit 1;
 * added 2 November 2026): the rules, on synthetic setups only.
 */
import { CALL_LENGTHS, type CallSetup, openSlots, readSetup } from "@/lib/call-setup";
import { MAX_CALL_LENGTHS, baseLength, chosenLength, fitsSomewhere, fromPrice, lengthsProblemWords, readCallLengths, slotsForLength } from "@/lib/call-lengths";
import { currencyRule } from "@/lib/money";
import { done, is, part } from "./check";

const NY = "America/New_York";
// Monday to Friday, 9:00 to 12:00.
const HOURS: [number, number][][] = [[], [[540, 720]], [[540, 720]], [[540, 720]], [[540, 720]], [[540, 720]], []];
const setup = readSetup({ kind: "weekly", minutes: 30, tz: NY, weekly: HOURS, noticeHours: 1, horizonDays: 14, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] }) as CallSetup;
type Call = Parameters<typeof readCallLengths>[1];
const call: Call = { setup: { kind: "weekly", seats: 1, weekly: HOURS }, currency: "usd", packaged: false, deposit: null, team: false };
const read = (raw: unknown, over: Partial<Call> = {}) => readCallLengths(raw, { ...call, ...over });

part("Reading the lengths");
is("one to three, shortest first, each price as typed", read([{ minutes: 60, price: "90" }, { minutes: 30, price: "50" }, { minutes: "90", price: "120,50" }]), { ok: true, lengths: [{ minutes: 30, cents: 5000 }, { minutes: 60, cents: 9000 }, { minutes: 90, cents: 12050 }] });
is("none, too many, a length a call cannot have, one twice", [
  read([]),
  read(Array.from({ length: MAX_CALL_LENGTHS + 1 }, (_, i) => ({ minutes: CALL_LENGTHS[i], price: "10" }))),
  read([{ minutes: 25, price: "10" }]),
  read([{ minutes: "9e1", price: "10" }]),
  read([{ minutes: 30, price: "10" }, { minutes: 30, price: "20" }]),
], [{ ok: false, problem: "none" }, { ok: false, problem: "too_many" }, { ok: false, problem: "length", index: 0 }, { ok: false, problem: "length", index: 0 }, { ok: false, problem: "twice", index: 1 }]);
const rule = currencyRule("usd");
is("a call is never free, nor below or above what a product may cost", [read([{ minutes: 30, price: "0" }]), read([{ minutes: 30, price: String((rule.minPrice - 1) / 100) }]), read([{ minutes: 30, price: String(rule.maxPrice / 100 + 1) }]), read([{ minutes: 30, price: "abc" }])].map((r) => (r.ok ? "kept" : r.problem)), ["price", "price", "price", "price"]);
const two = [{ minutes: 30, price: "50" }, { minutes: 60, price: "90" }];
is("several lengths only for weekly hours with one person a time", [read(two, { setup: { ...call.setup, seats: 4 } }), read(two, { setup: { ...call.setup, kind: "live" } })], [{ ok: false, problem: "kind" }, { ok: false, problem: "kind" }]);
is("one length is a weekly group's own and is kept; a dated call's lengths are its sessions', so a list is refused", [read([{ minutes: 60, price: "2" }], { setup: { ...call.setup, seats: 4 } }), read([{ minutes: 60, price: "2" }], { setup: { kind: "live", seats: 1, weekly: [[], [], [], [], [], [], []] } })], [{ ok: true, lengths: [{ minutes: 60, cents: 200 }] }, { ok: false, problem: "kind" }]);
is("a price is read only from text: a number is refused, never read as 5,000 or 50", [read([{ minutes: 30, price: 5000 }]), read([{ minutes: 30, price: 50 }]), read([{ minutes: 30, price: "5000" }])], [{ ok: false, problem: "price", index: 0 }, { ok: false, problem: "price", index: 0 }, { ok: true, lengths: [{ minutes: 30, cents: 500_000 }] }]);
is("a currency with no cents: 500 yen is kept, 99 is under the least a product may cost", [read([{ minutes: 30, price: "500" }], { currency: "jpy" }), read([{ minutes: 30, price: "99" }], { currency: "jpy" }), read([{ minutes: 30, price: "500.50" }], { currency: "jpy" })], [{ ok: true, lengths: [{ minutes: 30, cents: 500 }] }, { ok: false, problem: "price", index: 0 }, { ok: false, problem: "price", index: 0 }]);
is("a longer length never costs less than a shorter one, in whatever order typed; the same price is fine", [
  read([{ minutes: 30, price: "50" }, { minutes: 90, price: "45" }]),
  read([{ minutes: 90, price: "45" }, { minutes: 60, price: "60" }, { minutes: 30, price: "50" }]),
  read([{ minutes: 30, price: "50" }, { minutes: 60, price: "50" }]).ok,
], [{ ok: false, problem: "cheaper", index: 1, minutes: 90 }, { ok: false, problem: "cheaper", index: 0, minutes: 90 }, true]);
is("a length that fits in no stretch of the weekly hours", [read([{ minutes: 30, price: "1" }, { minutes: 120, price: "2" }], { setup: { ...call.setup, weekly: [[], [[540, 600]], [], [], [], [], []] } }), fitsSomewhere(HOURS, 180), fitsSomewhere(HOURS, 240)], [{ ok: false, problem: "fits", index: 1, minutes: 120 }, true, false]);
is("several lengths refused with packages, team booking, or a deposit not below every price", [
  read([{ minutes: 30, price: "50" }, { minutes: 60, price: "90" }], { packaged: true }),
  read([{ minutes: 30, price: "50" }, { minutes: 60, price: "90" }], { team: true }),
  read([{ minutes: 60, price: "90" }, { minutes: 30, price: "50" }], { deposit: 5000 }),
  read([{ minutes: 30, price: "50" }, { minutes: 60, price: "90" }], { deposit: 4999 }).ok,
  read([{ minutes: 30, price: "50" }], { packaged: true, team: true }).ok,
], [{ ok: false, problem: "package" }, { ok: false, problem: "team" }, { ok: false, problem: "deposit", index: 1, minutes: 30 }, true, true]);
is("each problem said in plain words", [lengthsProblemWords("price", "usd"), lengthsProblemWords("fits", "usd", 120), lengthsProblemWords("length", "usd"), lengthsProblemWords("cheaper", "usd", 90)], ["Type each length's price between 1 and 5,000.".replace("5,000", (rule.maxPrice / 100).toLocaleString("en-US")), "A 120-minute call doesn't fit in any of your weekly hours. Make one stretch longer, or pick a shorter length.", "Choose each length from 15, 20, 30, 45, 60, 90 or 120 minutes.", "A 90-minute call can't cost less than a shorter one. Raise its price, or lower the shorter one's."]);

part("The base and the price from");
const lengths = [{ minutes: 30, cents: 5000 }, { minutes: 90, cents: 12000 }];
is("the setup and the product keep the shortest, even from a list kept out of order", [baseLength(lengths), baseLength([...lengths].reverse()), baseLength([]), fromPrice([])], [{ minutes: 30, cents: 5000 }, { minutes: 30, cents: 5000 }, null, null]);
const kept = read([{ minutes: 90, price: "120" }, { minutes: 30, price: "50" }, { minutes: 60, price: "80" }]);
is("for every list kept, from is the base's price: the product, the page and from say one amount", kept.ok ? [fromPrice(kept.lengths), baseLength(kept.lengths)?.cents] : [], [5000, 5000]);

part("Choosing one, and its times");
is("the chosen length and its own price; one the call no longer has, none", [chosenLength(lengths, 90), chosenLength(lengths, "30"), chosenLength(lengths, 60), chosenLength(lengths, "9e1"), chosenLength(lengths, undefined)], [{ minutes: 90, cents: 12000 }, { minutes: 30, cents: 5000 }, null, null, null]);
const now = Date.UTC(2026, 10, 2, 12, 0);
const short = slotsForLength(setup, lengths[0], now, []);
const long = slotsForLength(setup, lengths[1], now, []);
is("the times for a length are the call's own at that length", [JSON.stringify(short) === JSON.stringify(openSlots({ ...setup, minutes: 30 }, now, [])), JSON.stringify(long) === JSON.stringify(openSlots({ ...setup, minutes: 90 }, now, []))], [true, true]);
is("a longer call only where the whole of it fits: three hours give six half hours and two hour-and-a-halves", [short[0].starts.length, long[0].starts.length], [6, 2]);
const [nine, , ten] = short[0].starts;
const halfPastNine = short[0].starts[1];
const tenThirty = long[0].starts[1];
const sameCall = [{ product: "p1", start: halfPastNine, end: halfPastNine + 30 * 60_000 }];
const longAtNine = slotsForLength(setup, lengths[1], now, sameCall, "p1")[0].starts;
is("a half hour of this same call booked at 9:30 keeps the long call off 9:00, and 10:30 stays offered", [longAtNine.includes(nine), longAtNine.includes(tenThirty)], [false, true]);
const bookedLong = [{ product: "p1", start: nine, end: nine + 90 * 60_000 }];
const shortAfter = slotsForLength(setup, lengths[0], now, bookedLong, "p1")[0].starts;
is("a long call booked at 9:00 keeps 9:30 and 10:00 off for a short one", [shortAfter.includes(halfPastNine), shortAfter.includes(ten)], [false, false]);

done();
