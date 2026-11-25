/**
 * A pipeline's database commands as the cost lines price them: each command once and, for the two scripts priced with
 * what they send inside (lib/flow-limits.ts), every command the script can send inside its EVAL too: the wait counted
 * on a run (WAIT_IF_RUN; Claude 5 ibuF's LEVE on #5347: the inner HDEL, HGET and HSET of offAt were counted by no cost
 * line) and the park counted on a run (PARK_IF_RUN; Claude 5 icFoe's LEVE on #5347: SES_COUNTED_WAIT_COMMANDS_PER_TRY
 * prices its six inside). Counted from each script's own text, so a command added to it is priced at once.
 */
import { PARK_IF_RUN, WAIT_IF_RUN } from "@/lib/flow-runs";

const callsIn = (script: string) => (script.match(/redis\.call\(/g) ?? []).length;
/** Every redis.call in WAIT_IF_RUN: the most commands one wait counted sends inside its EVAL. */
export const WAIT_IF_RUN_INSIDE = callsIn(WAIT_IF_RUN);
/** Every redis.call in PARK_IF_RUN: the most commands one park counted sends inside its EVAL. */
export const PARK_IF_RUN_INSIDE = callsIn(PARK_IF_RUN);

export function commandsOf(list: (string | number)[][]): number {
  return list.reduce((sum, command) => {
    const inside = command[0] !== "EVAL" ? 0 : command[1] === WAIT_IF_RUN ? WAIT_IF_RUN_INSIDE : command[1] === PARK_IF_RUN ? PARK_IF_RUN_INSIDE : 0;
    return sum + 1 + inside;
  }, 0);
}
