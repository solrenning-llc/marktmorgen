/**
 * Rule 24 on the outreach page (VR item 2): when the month's writing jobs could not be read, the page hands
 * OutreachStudio null, never 0; the line under "Write the email" says so in words and the button stays off until
 * the page is reloaded. A known count is said as before (control).
 */
import { readFileSync } from "node:fs";
import { outreachWriteHint } from "@/components/outreach-studio";
import { done, is } from "./check";

const UNKNOWN = /We could not check your AI allowance just now\. Reload the page in a minute to try again\./;
is("an unread allowance is said in words", UNKNOWN.test(outreachWriteHint(null)), true);
is("never as a count", /\(0 left\)|null left/.test(outreachWriteHint(null)), false);
is("control: a known count is said", /\(9 left\)/.test(outreachWriteHint(9)), true);

const page = readFileSync("app/studio/outreach/page.tsx", "utf8");
is("the outreach page catches an unread allowance as null, never 0", /aiLeft\(store\)\.catch\(\(\) => null\)/.test(page) && !/aiLeft\(store\)\.catch\(\(\) => 0\)/.test(page), true);
const studio = readFileSync("components/outreach-studio.tsx", "utf8");
is("the write button is off while the allowance is unknown", /disabled=\{busy !== null \|\| chosen === "" \|\| jobs === null\}/.test(studio), true);

done();
