/**
 * AX274 (3.1.5 Reading Level, and the W3C guidance for cognitive and learning
 * disabilities), for the feature pages under /platform: their sentences are
 * short enough to follow. Chromium on 13 November 2026 read 131 sentences of
 * 35 words or more on them. The 117 that lib/feature-pages.ts writes and no
 * open pull request changes are split, saying the same things, with no
 * number, plan, limit or promise changed.
 *
 * What must hold: every sentence of FEATURE_PAGES is under 35 words, except
 * the few named below, each with its reason.
 */
import { FEATURE_PAGES } from "@/lib/feature-pages";
import { done, is, part } from "./check";

const LIMIT = 35;

/** Sentences left as they are, by their first words, with the reason. */
const LEFT: Record<string, string> = {
  // An open pull request changes these two sentences; they wait for it.
  "Your store's address, name, bio, links, currency and the date it was created": "open pull request",
  "You, or a teammate allowed to export, can download a copy": "open pull request",
  // The list of what stays locked for 7 days: one short item after another,
  // read from LOCKED_LIST, so the security page and the studio name the same things.
  "But payments, your plan, your team, exports": "a list of short items",
};

const words = (s: string) => s.match(/[A-Za-z']+/g)?.length ?? 0;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

part(`every sentence on a feature page is under ${LIMIT} words`);
const long = new Set<string>();
for (const text of strings(FEATURE_PAGES)) {
  for (const sentence of text.split(/(?<=[.!?][”"’)]?)\s+/)) {
    if (words(sentence) >= LIMIT && !Object.keys(LEFT).some((start) => sentence.startsWith(start))) long.add(sentence);
  }
}
for (const sentence of long) console.log(`  ${words(sentence)} words: ${sentence}`);
is(`sentences of ${LIMIT} words or more`, long.size, 0);
done();
