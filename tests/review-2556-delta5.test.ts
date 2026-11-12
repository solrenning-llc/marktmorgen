/**
 * Review of #2556 at 0e3083163 (delta from 4d8ac350e): LOCKED_UNTIL_STAR_EXTRA is written down but summed into
 * no unit. Under the margin rule (MR: every customer at full use in the worst month, every cost before the
 * spend), the "*" state is a state the code allows for as long as failed reads keep coming, and then every
 * studio request that calls lockedUntil (every studio page, every locked-aware route) costs three commands more
 * than the studio unit it is priced at. Synthetic: reads the registry only.
 */
import { LOCKED_UNTIL_STAR_EXTRA, TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";
import { done, is, part } from "./check";

part("the studio unit holds lockedUntil at its worst");
is(
  "UNIT_COST.studio has room for LOCKED_UNTIL_STAR_EXTRA over the studio shape without it",
  UNIT_COST.studio - request("studio", 20 + TAKE_COMMANDS, 50_000) >= LOCKED_UNTIL_STAR_EXTRA,
  true,
);
done();
