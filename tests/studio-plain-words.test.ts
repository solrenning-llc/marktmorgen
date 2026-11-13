/**
 * AX274 (3.1.5 Reading Level, and the W3C guidance for cognitive and learning
 * disabilities): the studio says things in sentences short enough to follow. The
 * studio audit of 13 November 2026 read every sentence shown on the 46 studio
 * routes in Chromium: the reading grade of each page was 7 to 9, but 36
 * sentences ran from 35 to 51 words. Two of them are left for now, because an
 * open pull request changes the same sentence (#3562 in app/studio/page.tsx and
 * #3118 in components/affiliate-studio.tsx); the other 34 are split, saying the
 * same things, with no number, price, limit or promise changed.
 *
 * What must hold: the sentence that starts with each phrase below, as the source
 * writes it (whitespace and the HTML entities of JSX read as the words they
 * draw), is under 35 words.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const LIMIT = 35;
const flat = (s: string) =>
  s
    .replace(/&apos;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ");
const words = (s: string) => s.match(/[A-Za-z']+/g)?.length ?? 0;

/** The sentence that starts at `start`: up to the first full stop followed by a space, a quote, a backtick or the end. */
function sentence(file: string, start: string): string | null {
  const text = flat(readFileSync(file, "utf8"));
  const at = text.indexOf(start);
  if (at < 0) return null;
  const rest = text.slice(at);
  const end = rest.search(/\.(\s|"|`|<|$)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

part(`Each long studio sentence is now under ${LIMIT} words`);
for (const [file, start] of [
  ["lib/store-search-check.ts", "Each product page tells search engines its name"],
  ["components/attribution-table.tsx", "The same sales"],
  ["components/stats-panel.tsx", "Paid is sales for every 100 checkouts started"],
  ["components/kit-editor.tsx", "A page for brands at marktmorgen.com"],
  ["components/numbers-links-editor.tsx", "For a partner, a co-producer or a sponsor"],
  ["components/tips-editor.tsx", "A box on your store page where a fan"],
  ["components/answers-editor.tsx", "With three products or more, your store page also gets"],
  ["components/store-assistant-editor.tsx", "A chat in the corner of every page of your store"],
  ["components/store-assistant-editor.tsx", "it does not know, or the question is a complaint"],
  ["components/store-assistant-editor.tsx", "Only when you set none does an AI choose"],
  ["components/store-assistant-editor.tsx", "Only a buyer who checks it and types an address"],
  ["components/store-assistant-editor.tsx", "An AI adds one short, neutral line"],
  ["components/recovery-editor.tsx", "a buyer who said yes"],
  ["components/recovery-editor.tsx", "Each paid product's page offers the same under its buy box"],
  ["components/recovery-editor.tsx", "For calls and live sessions, the time the buyer picked"],
  ["components/webhook-editor.tsx", "Paste a Zapier"],
  ["app/studio/page.tsx", "An order is a purchase confirmed"],
  ["app/studio/pages/page.tsx", "Build each product's own page from up to"],
  ["components/thanks-note-editor.tsx", "What buyers of "],
  ["app/studio/community/page.tsx", "You choose which products let people in"],
  ["app/studio/site/page.tsx", "About you, where to start, how to work with you"],
  ["components/bundle-editor.tsx", "A buyer gets each product in the bundle exactly as if"],
  ["app/studio/memberships/page.tsx", "The next three months: each month keeps"],
  ["app/studio/integrations/page.tsx", "Connect Mailchimp, Kit, beehiiv or MailerLite"],
  ["app/studio/affiliates/page.tsx", "Each affiliate gets their own link"],
  ["components/affiliate-studio.tsx", "declined or removed cannot rejoin this way"],
  ["components/affiliate-studio.tsx", "Someone you declined or removed stays out"],
  ["components/affiliate-studio.tsx", "On their own page, approved affiliates pick"],
  ["components/affiliate-studio.tsx", "One sale earns one affiliate either way"],
  ["components/affiliate-studio.tsx", "an affiliate's link is reached from a paid search ad"],
  ["app/studio/calendar/page.tsx", "When you host a team call"],
  ["components/agreements-studio.tsx", "They get one email from your store's name"],
  ["app/studio/outreach/page.tsx", "We read its website for the address"],
  ["app/studio/phone/page.tsx", "A sale, a booking, a report in your community"],
] as const) {
  const s = sentence(file, start);
  is(`${file}: "${start.trim()}…" is found`, s !== null, true);
  const n = s === null ? Infinity : words(s);
  is(`${file}: "${start.trim()}…" has fewer than ${LIMIT} words (now ${n})`, n < LIMIT, true);
}

done();
