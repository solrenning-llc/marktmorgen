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

part("A request the provider refuses is refunded at once, and every text says so (Claude 5 icEJ's LEVE on #5456)");
is("the code refunds a refused request at once (requestAutoCaptions gives it back before answering)",
  /would not write captions[\s\S]{0,200}giveBack\(pending, null, refundKey\)/.test(readFileSync("lib/auto-captions.ts", "utf8")), true);
for (const [name, text] of Object.entries(sources)) {
  is(`${name}: a refused request is refunded at once, not after the hours`, /refuses\s+the\s+request[^.]{0,80}refunded\s+at\s+once/.test(text), true);
}

part("A lesson video deleted before its captions come is refunded without the wait, and every text says so (Claude 5 id8Ws's LEVE on #5456)");
is("the code refunds what never came when the video is gone (a 404 from the provider settles the order at once)",
  /answer\.status === 404\)\s*\{\s*\/\/ The video is gone, deleted with its lesson: what was not written is given back\./.test(readFileSync("lib/auto-captions.ts", "utf8")), true);
for (const [name, text] of Object.entries(sources)) {
  is(`${name}: a deleted lesson video is refunded without waiting for the hours`, /video\s+is\s+deleted[^.]{0,120}without\s+waiting/.test(text), true);
}

part("A charged request that never reached the provider is refunded usually within the hour, in every case at the first check after the hours (Claude 5 ia5d's and iaqyQ's LEVE, ichw's MEDIUM on #5456)");
is("the code refunds a charged order whose record was never confirmed, from the queue after ORDER_SETTLE_MS",
  /export const ORDER_SETTLE_MS = 15 \* 60_000;/.test(readFileSync("lib/auto-captions.ts", "utf8")), true);
// When the record's write landed but neither its reply nor its read-back reads, the key holds a Pending record, and the
// sweep refunds it only past GIVE_UP_HOURS (iaqyQ's probe: refunds 0 at T+2 h, 1 at T+49 h): no text promises less.
for (const [name, text] of Object.entries(sources)) {
  is(`${name}: never promises a request that never reached the provider is refunded without waiting`, /never\s+reaches\s+(our|the)\s+video\s+provider[^.;]{0,160}without\s+waiting/.test(text), false);
  is(`${name}: says it is refunded usually within the hour, otherwise at the first check after the hours`,
    /never\s+reaches\s+(our|the)\s+video\s+provider[^.;]{0,120}usually\s+within\s+the\s+hour[^.;]{0,80}otherwise\s+at\s+our\s+first\s+check\s+after/.test(text), true);
  // Claude 3 on #5456 @b1dd9b1d73: when Stripe's invoice or the provider's answer stays unknown, the code keeps the
  // order for a person (ORDER_LOOKS_MS, unknownLook) and never refunds it on its own: no "in every case".
  is(`${name}: promises nothing "in every case", and names the case where nobody can tell us`,
    [/in\s+every\s+case/.test(text), /never\s+reaches\s+(our|the)\s+video\s+provider[^.]{0,260}cannot\s+tell\s+us\s+what\s+happened/.test(text)], [false, true]);
  is(`${name}: promises no time in minutes for it`, /never\s+reaches\s+(our|the)\s+video\s+provider[^.;]{0,120}\d+\s+minutes/.test(text), false);
}
// "Usually within the hour" (Claude 5 ichw on #5456): the order settles at the first stream run after ORDER_SETTLE_MS,
// owes the refund for LOOK_AGAIN_MS more, and the refund is made at the next run: about 25 to 30 minutes, inside the hour.
{
  const code = readFileSync("lib/auto-captions.ts", "utf8");
  const settle = Number(/export const ORDER_SETTLE_MS = (\d+) \* 60_000;/.exec(code)?.[1]);
  const again = Number(/const LOOK_AGAIN_MS = (\d+) \* 60_000;/.exec(code)?.[1]);
  const cron = JSON.parse(readFileSync("vercel.json", "utf8")).crons.find((c: { path: string }) => c.path === "/api/cron/stream")?.schedule as string;
  const every = /^[\d,]+ \* \* \* \*$/.test(cron) ? 60 / cron.split(" ")[0].split(",").length : NaN;
  is("the refund of a request that never reached the provider is made within the hour: two runs past both waits",
    [Number.isFinite(settle + again + every), settle + again + 2 * every < 60], [true, true]);
}

part("The Terms and the help say what happens when the provider never confirms");
is("the Terms name the extra days and the studio page that says whom to write to", /\{DELIVERY_LOOK_DAYS\}\s+(more\s+)?days/.test(sources.terms) && /says\s+so\s+and\s+gives\s+the\s+address\s+to\s+write\s+to/.test(sources.terms), true);
is("the help says so in a sentence", /\$\{DELIVERY_LOOK_DAYS\}\s+(more\s+)?days/.test(sources.help), true);
is("the hours and the days are the code's", [GIVE_UP_HOURS, DELIVERY_LOOK_DAYS], [48, 14]);

done();
