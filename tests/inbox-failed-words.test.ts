/**
 * 663 [HF1], Claude 3 (cloud N) review on #3549 (LEVE, VR item 2): the studio inbox's "failed" words. lib/inbox.ts
 * suggestReply goes through lib/ai.ts `counted`, which gives the month's writing job back when a reservation refused
 * the request before any call reached the model, so "This try counted" is not always true. The words must hold in
 * both cases, as #3549 makes the outreach and numbers panels say: never "this try counted" as a fact, never
 * "nothing was counted" either, and "counted" only if the request reached the AI. Read from the source; no screen
 * or model is needed for a sentence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const source = readFileSync(join(process.cwd(), "components/inbox-studio.tsx"), "utf8");
const found = /\n\s*failed: "([^"]*)"/.exec(source);
const words = found ? found[1] : "";

part("The inbox's words for a suggestion that failed");
is("the words are there", Boolean(found), true);
is("never \"this try counted\" as a fact", /this try counted/i.test(words), false);
is("never \"nothing was counted\" either", /nothing was counted/i.test(words), false);
is("says it counted only if the request reached the AI", /if [^.]*reached the AI[^.]*counted as one of this month's writing jobs/i.test(words), true);
is("still says to try again", /Try again\./.test(words), true);
is("lib/inbox.ts still reaches the model through counted, which gives the job back", /import \{[^}]*\bcounted\b[^}]*\} from "@\/lib\/ai"/.test(readFileSync(join(process.cwd(), "lib/inbox.ts"), "utf8")), true);

done();
