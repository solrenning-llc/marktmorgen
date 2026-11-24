/**
 * #5010 row 190 (found by Claude 6 i51q while fixing Claude 5 icFoe's MEDIUM on #3427): the Terms, the feature page
 * and the help promised that AI captions not delivered within GIVE_UP_HOURS are refunded automatically. The code
 * (lib/auto-captions.ts syncAutoCaptions) refunds past GIVE_UP_HOURS only on an answer from the video provider that
 * says what was delivered; an answer that stays unknown is looked at for DELIVERY_LOOK_DAYS more, then kept for a
 * person, never refunded on it (refunding on an unknown answer could pay twice). Each text now says what holds.
 */
import { readFileSync } from "node:fs";
import { DELIVERY_LOOK_DAYS, GIVE_UP_HOURS, ORDER_LOOK_DAYS } from "@/lib/auto-captions-rules";
import { HELP_DATES } from "@/lib/help-dates";
import { done, is, part } from "./check";

const sources = {
  terms: readFileSync("app/terms/page.tsx", "utf8"),
  feature: readFileSync("lib/feature-pages.ts", "utf8"),
  help: readFileSync("lib/help-content.ts", "utf8"),
};
const code = readFileSync("lib/auto-captions.ts", "utf8");
/** The captions passage of each text, from the refused request to the studio's address, as a reader sees it. */
const passage = (text: string): string => {
  const from = text.search(/If\s+our\s+video\s+provider\s+refuses/);
  const to = text.indexOf("gives the address to write to", from);
  if (from < 0 || to < 0) return "";
  return text
    .slice(from, to)
    .replace(/\{" "\}/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/\$?\{([A-Z_]+)\}/g, "$1")
    .replace(/\s+/g, " ");
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
  // Claude 3 xvBY8 on #5456 @4db566b492: a provider that cannot be reached answers status 0 (lib/stream.ts askStream),
  // which the code takes as a refusal and refunds at once: every text says so, and no other sentence promises less.
  is(`${name}: a provider that cannot be reached is refunded at once too`, /refuses\s+the\s+request,\s+or\s+cannot\s+be\s+reached,[^.]{0,80}refunded\s+at\s+once/.test(text), true);
}
is("the code takes a provider that was not reached (status 0) as a refusal",
  [/`status` 0 when it was not reached/.test(readFileSync("lib/stream.ts", "utf8")), /if \(answer\.status !== 200 \|\| success === false\) \{\s*console\.error\("the video service would not write captions"/.test(code)], [true, true]);

part("A lesson video deleted before its captions come is refunded without the wait, and every text says so (Claude 5 id8Ws's LEVE on #5456)");
is("the code refunds what never came when the video is gone (a 404 from the provider settles the order at once)",
  /answer\.status === 404\)\s*\{\s*\/\/[^\n]*\n\s*return \(await settle\(id, raw as string, pending, pending\.got, now\)\)/.test(code), true);
for (const [name, text] of Object.entries(sources)) {
  is(`${name}: a deleted lesson video is refunded without waiting for the hours`, /video\s+is\s+deleted[^.]{0,120}without\s+waiting/.test(text), true);
}

part("A charged request never sent to the provider is refunded usually within the hour, otherwise at the first check after the hours (Claude 5 ia5d's and iaqyQ's LEVE, ichw's MEDIUM, Claude 3 xvBY8's LEVE on #5456)");
is("the code refunds a charged order whose record was never confirmed, from the queue after ORDER_SETTLE_MS", /export const ORDER_SETTLE_MS = 15 \* 60_000;/.test(code), true);
// When the record's write landed but neither its reply nor its read-back reads, the key holds a Pending record, and the
// sweep refunds it only past GIVE_UP_HOURS (iaqyQ's probe: refunds 0 at T+2 h, 1 at T+49 h): no text promises less.
// Claude 3 xvBY8 on #5456 @4db566b492: "never reaches" also read as a provider that does not answer, which is refunded
// at once; the case is a request never sent, and no text says "never reaches" any more.
const neverSent = /never\s+sent\s+to\s+(our|the)\s+video\s+provider/;
for (const [name, text] of Object.entries(sources)) {
  is(`${name}: no "never reaches", which overlaps a provider that cannot be reached`, /never\s+reaches/.test(passage(text)), false);
  is(`${name}: never promises a request never sent is refunded without waiting`, new RegExp(neverSent.source + "[^.;]{0,160}without\\s+waiting").test(text), false);
  is(`${name}: says it is refunded usually within the hour, otherwise at the first check after the hours`,
    new RegExp(neverSent.source + "[^.;]{0,120}usually\\s+within\\s+the\\s+hour[^.;]{0,80}otherwise\\s+at\\s+our\\s+first\\s+check\\s+after").test(text), true);
  is(`${name}: promises no time in minutes for it`, new RegExp(neverSent.source + "[^.;]{0,120}\\d+\\s+minutes").test(text), false);
  // Claude 3 on #5456 @b1dd9b1d73: when Stripe's invoice or the provider's answer stays unknown, the code keeps it for
  // a person (ORDER_LOOKS_MS, unknownLook) and never refunds it on its own: no "in every case".
  is(`${name}: promises nothing "in every case"`, /in\s+every\s+case/.test(passage(text)), false);
  // Claude 3 woRu on #5456 @8141d717c2, Claude 3 xvBY8 @4db566b492: when Stripe cannot say whether such a charge was
  // paid, the code looks for ORDER_LOOK_DAYS from the order, then stops (settleOrder logs it and counts it for the
  // owner's report, with nothing that brings it to a person): so no text says "by hand"; each says to write to us.
  is(`${name}: Stripe's unknown case is checked for the order's days, then the creator is told to write to us`,
    /[Ii]f\s+Stripe\s+cannot\s+tell\s+us\s+whether\s+such\s+a\s+request\s+was\s+paid,\s+we\s+keep\s+checking[^.;]{0,30}\s+for\s+\$?\{ORDER_LOOK_DAYS\}(\{" "\})?\s+days\s+after\s+the\s+order\.\s+After\s+that,\s+we\s+stop\s+checking\s+on\s+our\s+own:\s+write\s+to\s+us\s+at\s+support@marktmorgen\.com/.test(text), true);
  is(`${name}: promises no look "by hand"`, /by\s+hand/.test(passage(text)), false);
  // Claude 5 ichw on #5456 @defb20090d, Claude 3 xvBY8 @4db566b492: the provider's unknown case is one whole sentence,
  // the same in every text, the feature page included, with its days; the code asks what was delivered.
  is(`${name}: says how long we keep asking when the provider cannot tell us what it delivered`,
    /[Ii]f\s+our\s+video\s+provider\s+cannot\s+tell\s+us\s+what\s+it\s+delivered,\s+we\s+keep\s+asking\s+it\s+on\s+our\s+own\s+for\s+\$?\{DELIVERY_LOOK_DAYS\}\s+more\s+days\.\s+After\s+that,\s+the\s+course(&apos;|')s\s+page\s+in\s+your\s+studio\s+says\s+so\s+and\s+gives\s+the\s+address\s+to\s+write\s+to/.test(text), true);
  is(`${name}: never says what the provider "received"`, /what\s+it\s+received/.test(passage(text)), false);
}
is("the code stops looking at an order ORDER_LOOK_DAYS after it, and nothing lists it for a person",
  [ORDER_LOOK_DAYS, /const ORDER_LOOKS_MS = ORDER_LOOK_DAYS \* 86_400_000;/.test(code), /if \(age > ORDER_LOOKS_MS\) \{[^}]*countKept\("order"/.test(code), /if \(age > ORDER_LOOKS_MS\) \{[^}]*keepListed/.test(code)],
  [14, true, true, false]);
is("the code asks the provider for DELIVERY_LOOK_DAYS from the end of the hours, then keeps it for a person",
  [/const DELIVERY_LOOKS_MS = DELIVERY_LOOK_DAYS \* 86_400_000;/.test(code), /const past = now - pending\.at - GIVE_UP_HOURS \* 3_600_000;/.test(code), /if \(past > DELIVERY_LOOKS_MS\)/.test(code)],
  [true, true, true]);
// "Usually within the hour" (Claude 5 ichw on #5456): the order settles at the first stream run after ORDER_SETTLE_MS,
// owes the refund for LOOK_AGAIN_MS more, and the refund is made at the next run: at most 35 minutes, inside the hour.
{
  const settle = Number(/export const ORDER_SETTLE_MS = (\d+) \* 60_000;/.exec(code)?.[1]);
  const again = Number(/const LOOK_AGAIN_MS = (\d+) \* 60_000;/.exec(code)?.[1]);
  const cron = JSON.parse(readFileSync("vercel.json", "utf8")).crons.find((c: { path: string }) => c.path === "/api/cron/stream")?.schedule as string;
  const every = /^[\d,]+ \* \* \* \*$/.test(cron) ? 60 / cron.split(" ")[0].split(",").length : NaN;
  is("the refund of a request never sent is made within the hour: two runs past both waits, 35 minutes at most",
    [Number.isFinite(settle + again + every), settle + again + 2 * every], [true, 35]);
}

part("Each case is a sentence of its own, in plain words (Claude 3 xvBY8's LEVE on #5456, AAA 3.1.5)");
for (const [name, text] of Object.entries(sources)) {
  const words = passage(text);
  const sentences = words.split(/(?<=\.)\s+/).filter(Boolean);
  is(`${name}: the passage is found`, words.length > 400, true);
  is(`${name}: no semicolon joins two cases`, words.includes(";"), false);
  is(`${name}: no sentence of more than 40 words`, sentences.filter((s) => s.split(" ").length > 40), []);
  is(`${name}: what is refunded is what was paid, never "they"`, /\bthey\s+are\s+refunded|(?<!for\s)\bit\s+is\s+refunded/.test(words), false);
}

part("The Terms are dated no earlier than the help answer that says the same (Claude 3 xvBY8's LEVE on #5456)");
{
  const dated = /lastUpdated="([A-Z][a-z]+ \d{1,2}, \d{4})"/.exec(sources.terms)?.[1];
  const terms = dated ? new Date(`${dated} UTC`).toISOString().slice(0, 10) : "";
  is("the Terms' date is on or after the course answer's", terms >= HELP_DATES["can-i-sell-a-course"].updated, true);
}

part("The studio's note while Stripe has not confirmed a charge promises only what the code does (Claude 6 i51q, found fixing Claude 3 xvBY8's LEVE on #5456)");
{
  const editor = readFileSync("components/course-editor.tsx", "utf8");
  const note = /auto_checking: `([^`]*)`/.exec(editor)?.[1] ?? "";
  is("it promises no time in minutes (the order is looked at further apart for ORDER_LOOK_DAYS)", /\d+\s+minutes/.test(note), false);
  is("it promises no refund \"on its own\" (one Stripe never confirms is never refunded on its own)", /on\s+its\s+own/.test(note), false);
  is("it says the refund comes once Stripe confirms the charge", /refunded\s+once\s+Stripe\s+confirms/.test(note), true);
  is("past ORDER_LOOK_DAYS it gives the address to write to", /\$\{ORDER_LOOK_DAYS\}\s+days[^`]*write\s+to\s+\$\{SUPPORT_EMAIL\}/.test(note), true);
}

part("The Terms and the help say what happens when the provider never confirms");
is("the Terms name the extra days and the studio page that says whom to write to", /\{DELIVERY_LOOK_DAYS\}\s+(more\s+)?days/.test(sources.terms) && /says\s+so\s+and\s+gives\s+the\s+address\s+to\s+write\s+to/.test(sources.terms), true);
is("the help says so in a sentence", /\$\{DELIVERY_LOOK_DAYS\}\s+(more\s+)?days/.test(sources.help), true);
is("the hours and the days are the code's", [GIVE_UP_HOURS, DELIVERY_LOOK_DAYS], [48, 14]);

done();
