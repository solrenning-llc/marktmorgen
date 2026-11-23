/**
 * #5010 row 190 (found by Claude 6 i51q while fixing Claude 5 icFoe's MEDIUM on #3427): the Terms, the feature page
 * and the help promised that AI captions not delivered within GIVE_UP_HOURS are refunded automatically. The code
 * (lib/auto-captions.ts syncAutoCaptions) refunds past GIVE_UP_HOURS only on an answer from the video provider that
 * says what was delivered; an answer that stays unknown is looked at for DELIVERY_LOOK_DAYS more, then kept for a
 * person, never refunded on it (refunding on an unknown answer could pay twice). Each text now says what holds.
 */
import { readFileSync } from "node:fs";
import { DELIVERY_LOOK_DAYS, GIVE_UP_HOURS } from "@/lib/auto-captions-rules";
import { done, is, part } from "./check";

const sources = {
  terms: readFileSync("app/terms/page.tsx", "utf8"),
  feature: readFileSync("lib/feature-pages.ts", "utf8"),
  help: readFileSync("lib/help-content.ts", "utf8"),
};

part("No text promises a refund within the hours, whatever the provider answers");
for (const [name, text] of Object.entries(sources)) {
  is(`${name}: no 'not delivered within … refunded' promise`, /not\s+delivered\s+within\s+\$?\{GIVE_UP_HOURS\}\s+hours,?\s+(what\s+was\s+paid|is\s+refunded)/.test(text), false);
  is(`${name}: says the refund comes once the provider confirms what it delivered`, /once\s+(our|the)\s+video\s+provider\s+confirms\s+what\s+it\s+delivered/.test(text), true);
}

part("The Terms and the help say what happens when the provider never confirms");
is("the Terms name the extra days and the studio page that says whom to write to", /\{DELIVERY_LOOK_DAYS\}\s+(more\s+)?days/.test(sources.terms) && /says\s+so\s+and\s+gives\s+the\s+address\s+to\s+write\s+to/.test(sources.terms), true);
is("the help says so in a sentence", /\$\{DELIVERY_LOOK_DAYS\}\s+(more\s+)?days/.test(sources.help), true);
is("the hours and the days are the code's", [GIVE_UP_HOURS, DELIVERY_LOOK_DAYS], [48, 14]);

done();
