/**
 * The community picture door (app/api/store/community/upload, 9 November 2026) is paid by the buyer action the door
 * takes before it: the whole door costs no more than one buyer action at its heaviest (tests/plan-cost-registry.ts,
 * UNIT_COST.buyer, line buyer-actions). Its figure holds the file store's head that refuses a taken name, the
 * browser's upload through the door and the sweep's delete of a picture never used (two Advanced Operations), and
 * the sweep's own commands for it.
 */
import * as registry from "./plan-cost-registry";
import { BLOB_SIMPLE_OPERATION, COMMAND, COMMUNITY_DOOR_COST, UNIT_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

/** Read by name so the test also runs (and fails) where the figure is missing. */
const advanced = Number((registry as Record<string, unknown>).BLOB_ADVANCED_OPERATION);
const sweepCommands = Number((registry as Record<string, unknown>).COMMUNITY_SWEEP_COMMANDS);

part("The community picture door is inside one buyer action");
is("the head is priced, never zero", BLOB_SIMPLE_OPERATION > 0, true);
is("an Advanced Operation is priced, never zero, and dearer than a simple one", advanced > BLOB_SIMPLE_OPERATION, true);
is("the sweep's commands for one door are counted", sweepCommands >= 4, true);
is(
  "the door's figure holds its head, the browser's upload, the sweep's delete and the sweep's commands",
  COMMUNITY_DOOR_COST >= BLOB_SIMPLE_OPERATION + 2 * advanced + sweepCommands * COMMAND,
  true,
);
is("the door costs no more than one buyer action", COMMUNITY_DOOR_COST <= UNIT_COST.buyer, true);
done();
