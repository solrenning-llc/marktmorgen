/** The Path's line when the store's count of studio requests could not be read (rule 24): said to be unknown, never hidden as nothing used, and no plan suggested from it. */
export const PATH_PLAN_UNREAD = "How many studio requests you have used this window could not be read just now. Reload the page to check.";

/** A plan suggestion only from measured use, never from a sales forecast; `larger` whether this store can move to a larger plan now (lib/larger-plan.ts), so no plan is suggested where none can be had. `used` null: the count could not be read. */
export function pathPlanLine(used: number | null, limit: number, larger = false): string | null {
 if(used===null)return Number.isSafeInteger(limit)&&limit>0?PATH_PLAN_UNREAD:null;
 if(!Number.isSafeInteger(used)||!Number.isSafeInteger(limit)||used<0||limit<=0||used/limit<0.9)return null;
 return `You have used ${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} studio requests this window.${larger ? " Review plans if you need more room." : ""}`;
}
