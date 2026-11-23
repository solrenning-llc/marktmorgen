/**
 * A pipeline's database commands as the cost lines price them: each command once and, for the wait counted on a run
 * (WAIT_IF_RUN in lib/flow-runs.ts, one EVAL), every command its script can send inside it, too. Counted from the
 * script's own text, so a command added to it is priced at once (Claude 5 ibuF's LEVE on #5347: the inner HDEL, HGET
 * and HSET of offAt were counted by no cost line).
 */
import { WAIT_IF_RUN } from "@/lib/flow-runs";

/** Every redis.call in WAIT_IF_RUN: the most commands one wait counted sends inside its EVAL. */
export const WAIT_IF_RUN_INSIDE = (WAIT_IF_RUN.match(/redis\.call\(/g) ?? []).length;

export function commandsOf(list: (string | number)[][]): number {
  return list.reduce((sum, command) => sum + 1 + (command[0] === "EVAL" && command[1] === WAIT_IF_RUN ? WAIT_IF_RUN_INSIDE : 0), 0);
}
