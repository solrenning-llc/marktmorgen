/**
 * AX274 (3.1.5 Reading Level, and the W3C guidance for cognitive and learning
 * disabilities), for the help center: its answers are short enough to follow.
 * On 13 November 2026, 265 sentences of lib/help-content.ts had 35 words or
 * more, most of them inside answers that open on a press, where a page crawl
 * does not read them. Each is split, saying the same things, with no number,
 * plan, limit, price or promise changed, except those named below.
 *
 * What must hold: every sentence the help center's data holds is under 35
 * words, except the ones in LEFT, each with its reason.
 */
import * as help from "@/lib/help-content";
import { done, is, part } from "./check";

const LIMIT = 35;

/** Sentences left as they are, by their first words, with the reason. */
const LEFT: Record<string, string> = {
  // An open pull request changes these sentences; they wait for it.
  "Each store can have a team of up to five people": "open pull request",
  "Under “What customers are saying”": "open pull request",
  "A yearly plan is refunded at any time": "open pull request",
  "Your community's live room checks for new messages": "open pull request",
  "A paid plan's figures (visits, orders": "open pull request",
  "Before then, download your store's main data": "open pull request",
  "It holds your store's address, name, bio": "open pull request",
  "Your program is listed at marktmorgen.com/affiliate-programs": "open pull request",
  "A second box, “Show my program's numbers there too,”": "open pull request",
  "Every affiliate is asked, on your program page": "open pull request",
  "On Studio and Scale, approved affiliates can also have three posts": "open pull request",
  // The list of what stays locked for 7 days (LOCKED_LIST): one short item
  // after another, so the security answers and the studio name the same things.
  "Payments, your plan, your team, exports": "a list of short items",
  "Lose that inbox too, and you still get in at once with the emailed link alone, with payments": "a list of short items",
  "Lose that inbox too and you get in at once, with payments": "a list of short items",
};

const words = (s: string) => s.match(/[A-Za-z']+/g)?.length ?? 0;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

part(`every sentence in the help center is under ${LIMIT} words`);
const long = new Set<string>();
for (const text of strings(Object.values(help).filter((v) => typeof v !== "function"))) {
  for (const sentence of text.split(/(?<=[.!?][”"’)]?)\s+/)) {
    if (words(sentence) >= LIMIT && !Object.keys(LEFT).some((start) => sentence.startsWith(start))) long.add(sentence);
  }
}
for (const sentence of long) console.log(`  ${words(sentence)} words: ${sentence.slice(0, 120)}`);
is(`sentences of ${LIMIT} words or more`, long.size, 0);
done();
