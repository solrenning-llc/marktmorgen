/**
 * The wait counted on a run is priced with every command its script sends inside its EVAL (Claude 5 ibuF's LEVE on
 * #5347 @f79113d614): the tests that measure a wait and a switched-off look count them through commandsOf, and a
 * command added to WAIT_IF_RUN changes this count, so its price is looked at again.
 */
import { WAIT_IF_RUN } from "@/lib/flow-runs";
import { SWITCHED_OFF_LOOK_COMMANDS, WAIT_COMMANDS_PER_TRY, WAIT_COUNTED_COMMANDS } from "@/lib/flow-limits";
import { done, is } from "./check";
import { commandsOf, WAIT_IF_RUN_INSIDE } from "./flow-wait-inside";

is("WAIT_IF_RUN v4 sends at most nine commands inside its EVAL", [WAIT_IF_RUN.startsWith("-- marktmorgen:flow-wait:v4"), WAIT_IF_RUN_INSIDE], [true, 9]);
is("the wait counted is priced as its EVAL and every command inside", WAIT_COUNTED_COMMANDS, 1 + WAIT_IF_RUN_INSIDE);
is("a pipeline counts the wait's EVAL with its inside, and any other command once", commandsOf([["EVAL", WAIT_IF_RUN, 1, "k"], ["GET", "k"], ["EVAL", "return 1", 0]]), 1 + WAIT_IF_RUN_INSIDE + 1 + 1);
is("a wait is priced at least as two switched-off looks, its counted share", SWITCHED_OFF_LOOK_COMMANDS * 2 <= WAIT_COMMANDS_PER_TRY, true);
done();
