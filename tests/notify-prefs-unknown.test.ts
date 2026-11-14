/**
 * Synthetic only (Codex X2's review of #3013, MEDIUM): a stored list of alert emails switched off that is not a list
 * (an object, a string, a number) is unknown, never "nothing off". Optional alert emails fail closed while it is
 * unknown; a store saved before the choice existed (no field) still has every alert on, and a valid list still
 * filters events retired since.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { OPTIONAL_EVENTS, keptOff, wantsAlertEmail } from "@/lib/notify-prefs-rules";
import { done, is, part } from "./check";

part("A stored value that is not a list (Codex X2, #3013)");
// A stored null is a present value that is not a list (Codex X2's focal on #3013): unknown too, never "nothing off".
for (const [name, value] of [["an object", { refunds: true }], ["a string", "refunds"], ["a number", 3], ["true", true], ["a stored null", null]] as const) {
  const read = keptOff(value);
  is(`[CORRETO] ${name}: read as unknown`, read, null);
  is(`[CORRETO] ${name}: no optional alert is emailed`, OPTIONAL_EVENTS.every((event) => !wantsAlertEmail(read, event)), true);
}

part("What stays as it was");
is("no field (a store saved before the choice): every alert on", keptOff(undefined), []);
is("a valid empty list: every alert on", OPTIONAL_EVENTS.every((event) => wantsAlertEmail(keptOff([]), event)), true);
is("a valid list keeps filtering events retired since", keptOff(["refunds", "retired-kind", "traffic"]), ["traffic", "refunds"]);
done();
