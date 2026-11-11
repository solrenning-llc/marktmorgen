/**
 * VR (no make-believe): the visitors a store's pages count are each day's distinct visitors, added up over the days
 * (lib/stats.ts salts a visitor's mark with the day, so nobody is followed from one day to the next), and each day's
 * count is a HyperLogLog estimate. A person who comes back on another day is counted again. The figure shown to a brand
 * in the media kit (/@handle/media-kit) and on a shared numbers link (/numbers/<id>) must say that, never "Visitors" as
 * if it were the number of people.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { kitWords } from "@/lib/buyer-words/kit";

const LANGUAGES = ["en", "es", "fr", "de", "it", "nl", "pt"] as const;
const OLD_LABELS = ["Visitors, last 30 days", "Visitantes, últimos 30 días", "Visiteurs, 30 derniers jours", "Besucher, letzte 30 Tage", "Visitatori, ultimi 30 giorni", "Bezoekers, laatste 30 dagen", "Visitantes, últimos 30 dias"];

test("the media kit's label says the figure is daily visitors added up, in every language", () => {
  for (const language of LANGUAGES) {
    const w = kitWords(language);
    assert.ok(!OLD_LABELS.includes(w.countedVisitors), `${language}: "${w.countedVisitors}" reads as a number of people`);
  }
  const en = kitWords("en");
  assert.match(en.countedVisitors, /daily visitors/i);
  assert.match(en.countedNote("Nov 11, 2026"), /counted again/i);
  assert.match(en.countedNote("Nov 11, 2026"), /estimate/i);
});

test("a shared numbers link says the same", () => {
  const page = readFileSync("app/numbers/[id]/page.tsx", "utf8");
  assert.doesNotMatch(page, />Visitors</, "the column reads as a number of people");
  assert.match(page, /Daily visitors/);
  assert.match(page, /counted again/);
});
