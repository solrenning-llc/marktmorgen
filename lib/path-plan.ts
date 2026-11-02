/** A plan suggestion only from measured use, never from a sales forecast; `larger` whether this store can move to a larger plan now (lib/larger-plan.ts), so no plan is suggested where none can be had. */
export function pathPlanLine(used: number, limit: number, larger = false): string | null {
 if(!Number.isSafeInteger(used)||!Number.isSafeInteger(limit)||used<0||limit<=0||used/limit<0.9)return null;
 return `You have used ${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} studio requests this window.${larger ? " Review plans if you need more room." : ""}`;
}
