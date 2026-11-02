/**
 * The help center's answer on bringing a sequence from another service
 * (544 [SQ9], unit 3; added 2 November 2026): it says only what the studio's
 * "Bring in a sequence" does, with the box's own words and the code's own
 * numbers, and claims nothing about how another service exports.
 */
import { readFileSync } from "node:fs";
import { MAX_SEQUENCE_FILE_BYTES, SEQUENCE_TEMPLATE } from "@/lib/sequence-template";
import { MAX_STEPS } from "@/lib/flow-limits";
import { done, is } from "./check";

const help = readFileSync("lib/help-content.ts", "utf8");
const at = help.indexOf('q: "Can I bring my email sequences from another service?"');
const answer = help.slice(at, help.indexOf("\n      },", at));
const box = readFileSync("components/sequence-import-box.tsx", "utf8");
const route = readFileSync("app/api/store/mail/route.ts", "utf8");
is("the question is there, in the email answers, once", [at > 0, help.split("Can I bring my email sequences from another service?").length - 1, at < help.indexOf('q: "Can I email the people on my list?"')], [true, 1, true]);
is("the box's own words, each still in the box", ["Download the template (CSV)", "Bring in a sequence", "Read the file"].map((w) => answer.includes(`“${w}”`) && box.includes(w)), [true, true, true]);
is("the numbers and columns from the code, never typed", [answer.includes("${SEQUENCE_TEMPLATE.join(\", \")}"), answer.includes("${MAX_SEQUENCE_FILE_BYTES / 1000} KB"), answer.includes("A sequence holds up to ${MAX_STEPS} emails; any after that are left out and listed."), SEQUENCE_TEMPLATE.length, MAX_SEQUENCE_FILE_BYTES, MAX_STEPS > 0], [true, true, true, 5, 150_000, true]);
const studio = readFileSync("components/email-studio.tsx", "utf8");
const flows = readFileSync("lib/flows.ts", "utf8");
is("what it says happens is what the code does: Studio only; a new sequence saved paused, switched on only from its card", [route.includes('if (monthlyAllowance(store) === 0) return fail("plan", 403);') && route.indexOf('if (monthlyAllowance(store) === 0) return fail("plan", 403);') < route.indexOf('if (action === "flow-import")'), answer.includes("It is saved paused: nothing is sent until you preview it and switch it on from its card."), studio.includes("active: draft.id ? draft.active : false"), /opts\.activate/.test(flows)], [true, true, true, true]);
is("what is listed is what the reader lists, and only known tracking addresses are taken out", [answer.includes("Each picture, tracked link and merge field taken out, each preview text, which an email in a sequence does not have yet, and each email left out is listed by its line in the file"), answer.includes("links that go through a known click-tracking address"), readFileSync("lib/sequence-import.ts", "utf8").includes("TRACKER_HOSTS")], [true, true, true]);
is("the box's own limit comes from the code too", readFileSync("components/sequence-import-box.tsx", "utf8").includes("KB and ${MAX_STEPS} emails."), true);
is("no claim about how another service exports, no figure but ours", [/Mailchimp|Kit|ActiveCampaign|Beehiiv|MailerLite|export/i.test(answer), /\d/.test(answer.replace(/\$\{[^}]*\}/g, "").replace(/\*\|FNAME\|\*/, "").replace(/544 \[SQ9\]/, ""))], [false, false]);

done();
