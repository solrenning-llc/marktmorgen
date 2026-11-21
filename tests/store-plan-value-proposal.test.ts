/**
 * 250 [ST3]: the proposal of more value on the Store plan at no cost
 * (docs/store-plan-value-proposal.md). A PROPOSAL only: nothing changes a
 * feature, price or limit. What fails here: the document missing, not marked
 * as a proposal, or its figures no longer what the code says.
 */
import { readFileSync } from "node:fs";
import { AI_MONTHLY } from "@/lib/ai-rules";
import { ANSWERS_MONTHLY } from "@/lib/answers-rules";
import { ACTIVE_FLOWS_BY_TIER, DAILY_RUNS_BY_TIER } from "@/lib/flow-limits";
import { TEAM_LIMITS } from "@/lib/team-scheduling-rules";
import { PRO_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS, hasPro, monthlyEmails } from "@/lib/plan";
import { done, is } from "./check";

const doc = readFileSync("docs/store-plan-value-proposal.md", "utf8");
is("it says it is a proposal and changes nothing", [doc.includes("PROPOSAL"), doc.includes("Nothing in this document changes")], [true, true]);
is("Store has none of what Pro switches on, today", [hasPro("creator"), monthlyEmails("creator"), AI_MONTHLY.creator, ANSWERS_MONTHLY.creator, ACTIVE_FLOWS_BY_TIER.creator, DAILY_RUNS_BY_TIER.creator, TEAM_LIMITS.creator.eventTypes], [false, 0, 0, 0, 0, 0, 0]);
const rows: [string, string][] = [
  ["list emails", `| ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} | ${SCALE_MONTHLY_EMAILS.toLocaleString("en-US")} |`],
  ["AI writing", `| ${AI_MONTHLY.pro} | ${AI_MONTHLY.scale} |`],
  ["short answers", `| ${ANSWERS_MONTHLY.pro} | ${ANSWERS_MONTHLY.scale} |`],
  ["active workflows", `| ${ACTIVE_FLOWS_BY_TIER.pro} | ${ACTIVE_FLOWS_BY_TIER.scale} |`],
  ["workflow runs a day", `| ${DAILY_RUNS_BY_TIER.pro} | ${DAILY_RUNS_BY_TIER.scale} |`],
  ["team event types", `| ${TEAM_LIMITS.pro.eventTypes} | ${TEAM_LIMITS.scale.eventTypes} |`],
];
for (const [what, cells] of rows) is(`its ${what} row has the code's figures`, doc.includes(cells), true);
is("no claim about competitors without a dated source (VR item 7, review of #3726)", /competitors put/i.test(doc), false);
done();
