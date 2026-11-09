/**
 * The community picture door's check of the file store (one head, app/api/store/community/upload, 9 November 2026)
 * is paid by the buyer action the door takes before it: the whole door, the head included, costs no more than one
 * buyer action at its heaviest (tests/plan-cost-registry.ts, UNIT_COST.buyer, line buyer-actions).
 */
import { BLOB_SIMPLE_OPERATION, COMMUNITY_DOOR_COST, UNIT_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

part("The community picture door is inside one buyer action");
is("the head is priced, never zero", BLOB_SIMPLE_OPERATION > 0, true);
is("the door, its head included, costs no more than one buyer action", COMMUNITY_DOOR_COST <= UNIT_COST.buyer, true);
is("and the head is part of the door's figure", COMMUNITY_DOOR_COST > BLOB_SIMPLE_OPERATION, true);
done();
