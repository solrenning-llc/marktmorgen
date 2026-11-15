/**
 * The change events' `previous` (378 [TB4] complement WG (a); lib/webhooks.ts,
 * changedFields): only the fields of `from` whose value differs from `to`, as
 * they were; nothing when nothing changed. membership.changed carries it
 * (tests/webhook-more-events.test.ts reads it through the Stripe events), and
 * call.moved builds it from the same two times it sends as from and to
 * (lib/calls.ts, moveBooking).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedFields } from "@/lib/webhooks";
import { done, is, part } from "./check";

part("Only what changed, as it was");
is("a price and an interval", changedFields({ price: "p_m", amount_cents: 900, interval: "month", quantity: 1 }, { price: "p_y", amount_cents: 9000, interval: "year", quantity: 1 }), { price: "p_m", amount_cents: 900, interval: "month" });
is("a quantity alone", changedFields({ price: "p_m", quantity: 1 }, { price: "p_m", quantity: 3 }), { quantity: 1 });
is("nothing changed, nothing in it", changedFields({ start: "a", end: "b" }, { start: "a", end: "b" }), {});
is("a value that became null is said as it was", changedFields({ price: "p_m" as string | null }, { price: null }), { price: "p_m" });
is("a moved call's start and end", changedFields({ start: "2026-10-24T15:00:00.000Z", end: "2026-10-24T15:30:00.000Z" }, { start: "2026-10-25T16:00:00.000Z", end: "2026-10-25T16:30:00.000Z" }), { start: "2026-10-24T15:00:00.000Z", end: "2026-10-24T15:30:00.000Z" });
is("a call moved to a longer slot at the same start says only its end", changedFields({ start: "s", end: "e1" }, { start: "s", end: "e2" }), { end: "e1" });

part("call.moved builds it from the times it sends");
const calls = readFileSync(join(process.cwd(), "lib/calls.ts"), "utf8");
const at = calls.indexOf('emitEvent(store, "call.moved"');
const call = calls.slice(at, calls.indexOf("}).catch(", at));
is("from, to and previous are the same two times", ["from: was,", "to: movedTo,", "previous: changedFields(was, movedTo),"].every((line) => call.includes(line)), true);

done();
