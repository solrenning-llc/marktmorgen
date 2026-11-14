/**
 * WCAG 3.1.4 (abbreviations) and 3.1.5 (reading level) on the words a buyer
 * reads about a community's live events, in English: "RSVP" is said in plain
 * words ("going", "said you are coming", "your place"), never as an
 * abbreviation. The other six languages never used it.
 *
 * A ratchet: in the English buyer words, only the lines an open pull request
 * still changes may keep "RSVP" (each listed by its key), until that pull
 * request lands and they are rewritten too. Nothing new may add it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Lines open PRs change on 14 November 2026: #2992 next to the event buttons, #3024 beside the email choice. */
const WAITING = new Set(["canceledByCreator", "cancelRsvp", "rsvpTakePlace", "rsvp", "emailMeAnnounces"]);
/** They name the "Cancel my RSVP" button, which waits for #2992: they change with it. */
const NAMES_THE_BUTTON = new Set(["evMovedBody", "evReminderBody"]);

function keyOf(lines: string[], at: number): string {
  for (let i = at; i >= 0; i--) {
    const found = /^\s{2,4}([A-Za-z]+)\s*:/.exec(lines[i]);
    if (found) return found[1];
  }
  return "?";
}

const community = readFileSync("lib/buyer-words/community.ts", "utf8").split("\n");
const englishEnd = community.findIndex((line) => line.startsWith("const es"));
assert.ok(englishEnd > 0, "the English community words are still first in their file");
const left = community.slice(0, englishEnd).flatMap((line, i) => (line.includes("RSVP") ? [keyOf(community, i)] : []));
assert.deepEqual([...new Set(left.filter((key) => !WAITING.has(key) && !NAMES_THE_BUTTON.has(key)))], [], "in the English community words, RSVP is said in plain words except where an open PR still changes the line");

for (const file of ["lib/buyer-words/affiliates.ts", "lib/buyer-words/event-file.ts"]) {
  const english = readFileSync(file, "utf8").split(/\nconst (es|fr|de|it|nl|pt)\b/)[0];
  assert.doesNotMatch(english, /RSVP/, `${file}: the English buyer words say it in plain words`);
}

for (const code of ["es", "fr", "de", "it", "nl", "pt"]) {
  const block = readFileSync("lib/buyer-words/community.ts", "utf8").split(new RegExp(`\\nconst ${code}: CommunityWords = \\{`))[1]?.split(/\nconst [a-z]{2}: CommunityWords = \{/)[0] ?? "";
  assert.ok(block.length > 0, `${code}: its community words are found`);
  assert.doesNotMatch(block, /RSVP/, `${code}: never used the abbreviation`);
}
console.log(`RSVP: said in plain words in English buyer words; ${new Set(left).size} keys wait for open PRs`);
