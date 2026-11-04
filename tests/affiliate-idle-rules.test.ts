/**
 * Affiliates with no sale and no lead for N days, removed only after a
 * warning (630 [HN6](3), unit 1: lib/affiliate-idle-rules.ts).
 */
import { IDLE_WARN_DAYS, MAX_IDLE_DAYS, MIN_IDLE_DAYS, idleProblem, idleStep, readIdleDays } from "@/lib/affiliate-idle-rules";
import { done, is, part } from "./check";

const DAY = 86_400;
const T0 = 1_800_000_000;
const facts = (over: Partial<{ status: string; since: number; lastSale: number; lastLead: number; warnedAt: number; onSince: number }> = {}) => ({
  status: "approved",
  since: T0,
  lastSale: 0,
  lastLead: 0,
  warnedAt: 0,
  onSince: 0,
  ...over,
});

part("The creator's choice");
is("missing: off", readIdleDays(undefined), 0);
is("the least allowed", readIdleDays(MIN_IDLE_DAYS), 90);
is("the most allowed", readIdleDays(MAX_IDLE_DAYS), 730);
is("as typed in a field", readIdleDays("180"), 180);
for (const bad of [89, 731, 120.5, -90, "ninety", true, {}, Number.NaN]) {
  is(`${JSON.stringify(bad)} is off`, readIdleDays(bad), 0);
}
is("off is not a problem", [idleProblem(undefined), idleProblem(0), idleProblem(""), idleProblem("0"), idleProblem(null)], [null, null, null, null, null]);
is("a number in range is not a problem", idleProblem(365), null);
is("too few days is refused, never quietly turned off", idleProblem(30), "idle_days");
is("too many days is refused", idleProblem(1_000), "idle_days");
is("a fraction is refused", idleProblem(90.5), "idle_days");

part("Nothing happens unless it is on and the affiliate is approved");
is("off", idleStep(facts(), 0, T0 + 400 * DAY), { do: "none" });
is("a choice out of range is off", idleStep(facts(), 30, T0 + 400 * DAY), { do: "none" });
for (const status of ["pending", "declined", "removed"]) {
  is(`${status}: nothing`, idleStep(facts({ status }), 90, T0 + 400 * DAY), { do: "none" });
}
is("nothing known about when: nothing, never idle since 1970", idleStep(facts({ since: 0 }), 90, T0), { do: "none" });

part("The warning comes first, IDLE_WARN_DAYS before the day");
is("active: nothing", idleStep(facts(), 90, T0 + 60 * DAY), { do: "none" });
is("a day before the warning is due: nothing", idleStep(facts(), 90, T0 + (90 - IDLE_WARN_DAYS - 1) * DAY), { do: "none" });
is("on the day the warning is due: warn, naming the removal day", idleStep(facts(), 90, T0 + (90 - IDLE_WARN_DAYS) * DAY), { do: "warn", removeOn: T0 + 90 * DAY });
is("not warned and already past the day: warned now, with the full warning", idleStep(facts(), 90, T0 + 400 * DAY), { do: "warn", removeOn: T0 + 414 * DAY });

part("Warned, then removed only when the named day comes");
const warned = T0 + 76 * DAY;
is("warned, before the day: wait", idleStep(facts({ warnedAt: warned }), 90, T0 + 89 * DAY), { do: "wait", removeOn: T0 + 90 * DAY });
is("warned, on the day: removed", idleStep(facts({ warnedAt: warned }), 90, T0 + 90 * DAY), { do: "remove" });
const late = T0 + 400 * DAY;
is("switched on late: never removed sooner than the full warning", idleStep(facts({ warnedAt: late }), 90, late + 13 * DAY), { do: "wait", removeOn: late + IDLE_WARN_DAYS * DAY });
is("and removed once it has passed", idleStep(facts({ warnedAt: late }), 90, late + IDLE_WARN_DAYS * DAY), { do: "remove" });
is("the creator lengthens the choice after the warning: the old warning is set aside", idleStep(facts({ warnedAt: warned, onSince: T0 + 80 * DAY }), 180, T0 + 90 * DAY), { do: "none" });
is("and a fresh warning names the new day", idleStep(facts({ warnedAt: warned, onSince: T0 + 80 * DAY }), 180, T0 + 166 * DAY), { do: "warn", removeOn: T0 + 180 * DAY });
is("lengthened with no record of when: a warning outside the new stretch is still set aside", idleStep(facts({ warnedAt: warned }), 730, T0 + 730 * DAY), { do: "warn", removeOn: T0 + 744 * DAY });
is("shortened after the warning: warned afresh, never removed on the spot", idleStep(facts({ warnedAt: warned, onSince: T0 + 80 * DAY }), 90, T0 + 85 * DAY), { do: "warn", removeOn: T0 + 99 * DAY });
is("switched off and on again long after an old warning: a fresh warning first", idleStep(facts({ warnedAt: warned, onSince: T0 + 300 * DAY }), 90, T0 + 300 * DAY), { do: "warn", removeOn: T0 + 314 * DAY });
is("the creator switches it off after the warning: nothing", idleStep(facts({ warnedAt: warned }), 0, T0 + 200 * DAY), { do: "none" });

part("A sale or a lead starts the count again");
is("a sale after the warning: the old warning no longer counts", idleStep(facts({ warnedAt: warned, lastSale: warned + DAY }), 90, T0 + 90 * DAY), { do: "none" });
is("a lead after the warning: likewise", idleStep(facts({ warnedAt: warned, lastLead: warned + DAY }), 90, T0 + 90 * DAY), { do: "none" });
is(
  "quiet again for the whole stretch: a fresh warning before any removal",
  idleStep(facts({ warnedAt: warned, lastSale: warned + DAY }), 90, warned + DAY + (90 - IDLE_WARN_DAYS) * DAY),
  { do: "warn", removeOn: warned + DAY + 90 * DAY },
);
is("restored by the creator: counted from the restore", idleStep(facts({ since: T0 + 300 * DAY, warnedAt: warned, lastSale: T0 }), 90, T0 + 310 * DAY), { do: "none" });
is("an older sale than the approval does not shorten the count", idleStep(facts({ since: T0, lastSale: T0 - 500 * DAY }), 90, T0 + 60 * DAY), { do: "none" });
is("a time in the future is not a reason to remove anybody", idleStep(facts({ lastSale: T0 + 9_999 * DAY }), 90, T0 + 400 * DAY), { do: "none" });

part("Times as they really arrive");
const ms = (s: number) => s * 1000;
is("an approval time in milliseconds (Affiliate.decidedAt) is read as such", idleStep(facts({ since: ms(T0) }), 90, T0 + 76 * DAY), { do: "warn", removeOn: T0 + 90 * DAY });
is("a warning in milliseconds likewise", idleStep(facts({ since: ms(T0), warnedAt: ms(warned) }), 90, T0 + 90 * DAY), { do: "remove" });
is("the number of days as typed in a field", idleStep(facts(), "180", T0 + 166 * DAY), { do: "warn", removeOn: T0 + 180 * DAY });
is("warned in the same second as the last sale: not a warning for this stretch", idleStep(facts({ lastSale: warned, warnedAt: warned }), 90, warned + 90 * DAY), { do: "warn", removeOn: warned + 104 * DAY });
for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
  is(`now ${bad}: nothing, never a warning with no real date`, idleStep(facts({ warnedAt: warned }), 90, bad), { do: "none" });
}
is("a warning dated in the future does not remove early", idleStep(facts({ warnedAt: T0 + 500 * DAY }), 90, T0 + 100 * DAY), { do: "wait", removeOn: T0 + 514 * DAY });

done();
