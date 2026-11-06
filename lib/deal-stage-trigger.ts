/**
 * "A deal entered a stage" as a workflow trigger (added 17 October 2026,
 * HighLevel audit H18's stage trigger): what starts the one workflow a
 * stage of a pipeline may start (lib/flows.ts, trigger "stage").
 *
 * A deal enters a stage when the store's team makes it in that stage, or
 * moves it there from another stage or pipeline, on the board. Three other
 * ways a deal lands in a stage start nothing, on purpose: a form response
 * made into a deal (that review never enrolls anybody,
 * docs/form-opportunity-conversion.md), the moves made when a stage or a
 * pipeline is removed (the creator tidying the board, not a deal moving
 * on), and a workflow's own deal step (a run's cost has a fixed ceiling,
 * lib/flow-limits.ts; a step that starts another workflow is how one hands
 * a person on, and it is priced as a step).
 *
 * Only the person the deal names, by address, and only while they are on the
 * store's list and agreed to hear from the creator (lib/flows.ts, enroll):
 * a deal with nobody named, or with somebody who never joined the list,
 * starts nothing and sends nothing.
 *
 * What it costs: on a plan with workflows, the check is one more of the
 * store's studio requests (STAGE_TRIGGER_UNITS), taken before it is made;
 * a run it starts counts in the day's runs like every other
 * (lib/flow-limits.ts). On a plan without workflows nothing is read.
 */
import type { Deal } from "@/lib/crm-rules";
import { activeFlowLimit } from "@/lib/flow-limits";
import { enroll } from "@/lib/flows";
import type { Store } from "@/lib/store";
import { countStudio } from "@/lib/studio-route";

/** Studio requests a deal entering a stage takes, for checking the workflow it may start: up to STAGE_ENTRY_COMMANDS commands, inside one. */
export const STAGE_TRIGGER_UNITS = 1;

/** Whether saving `deal` over `before` (none for a new deal) is it entering a stage, with somebody named. */
export function entersStage(deal: Pick<Deal, "email" | "stage">, before: Pick<Deal, "stage"> | null | undefined): boolean {
  return Boolean(deal.email) && (!before || before.stage !== deal.stage);
}

export type StageTrigger = "none" | "checked" | "not_checked";

/**
 * After a deal was saved from the studio: starts the workflow its new stage
 * starts, for the person it names. "none" when nothing could start (no
 * address, the same stage, a plan without workflows); "not_checked" when the
 * studio's count refused it (its figure used, no place this month, not counted)
 * or the check failed. Never throws.
 */
export async function dealEnteredStage(store: Store, deal: Pick<Deal, "email" | "stage">, before: Pick<Deal, "stage"> | null | undefined): Promise<StageTrigger> {
  if (!entersStage(deal, before) || activeFlowLimit(store) === 0) return "none";
  try {
    const counted = await countStudio(store, null, STAGE_TRIGGER_UNITS);
    if (!counted.ok) return "not_checked";
    await enroll(counted.store ?? store, deal.email, { joined: false, stage: deal.stage });
    return "checked";
  } catch (error) {
    console.error("checking a deal stage's workflow failed", error);
    return "not_checked";
  }
}
