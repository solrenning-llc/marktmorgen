/**
 * Claude 6 i51q on #4988 (cost LOW): a fenced activity line is written by every studio request studioAccess counts, and
 * also by the essential requests that are counted apart from the studio figure (ESSENTIAL_PER_DAY a day: a teammate's
 * export of buyers' data goes through studioAccess, a teammate leaving goes through the team route). The fence's line
 * (teamLogFenceUsd) must price both, so unknown is never zero.
 */
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";
import { TEAM_LOG_FENCE_COMMANDS } from "@/lib/team";
import { COMMAND, DAY_WINDOWS, TEAM_LOG_LINES_PER_STUDIO_REQUEST, teamLogFenceUsd } from "./plan-cost-registry";
import { done, is } from "./check";

for (const tier of Object.keys(STORE_ALLOWANCES) as (keyof typeof STORE_ALLOWANCES)[]) {
  const requests = STORE_ALLOWANCES[tier].studio + ESSENTIAL_PER_DAY * DAY_WINDOWS;
  const floor = requests * TEAM_LOG_LINES_PER_STUDIO_REQUEST * TEAM_LOG_FENCE_COMMANDS * COMMAND;
  is(`${tier}: the fence is priced on the studio figure and on every essential request of the month`, teamLogFenceUsd(tier) >= floor - 1e-12, true);
}
done();
