export const calls:string[]=[];
/** What the route gave each pass, and whether the trial nudges fail this time (r24 unit 5.1). */
export const world={trialThrows:false,trialDeadline:0,requestsDeadline:0,onRenewal:()=>{}};
export async function cronAllowed(){return true;}
export async function sendReminders(){calls.push("renewal");world.onRenewal();return {sent:1};}
export async function sendFailedPlanNotices(){calls.push("failed");return 0;}
export async function sendTrialNudges(_now?:number,deadline=0){calls.push("trial");world.trialDeadline=deadline;if(world.trialThrows)throw Error("the subscription list page is not a complete bounded observation");return {sent:0,failed:0,seen:0,complete:true};}
export async function sendDueReminders(deadline=0){calls.push("requests");world.requestsDeadline=deadline;return {sent:0,skipped:0};}
