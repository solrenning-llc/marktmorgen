export const calls:string[]=[];
export async function cronAllowed(){return true;}
export async function sendReminders(){calls.push("renewal");return {sent:1};}
export async function sendFailedPlanNotices(){calls.push("failed");return 0;}
export async function sendTrialNudges(){calls.push("trial");return 0;}
export async function sendDueReminders(){calls.push("requests");return {sent:0,skipped:0};}
export async function withinLimit(){return true;}
