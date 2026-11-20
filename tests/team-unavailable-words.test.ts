/**
 * A team save the server could not confirm (Claude 5 iacVn3r's LOW on #4987): app/api/store/call-team answers 503
 * "unavailable" when WRITE_TEAM_IF_LIVE gave no exact answer, and lib/team-booking.ts says the HSET may then have been
 * applied. The studio's team editor must say so honestly: never "Nothing was saved" (VR item 2), and point the creator
 * to reload the page to see what is saved. Read in the source, as tests/team-pick.test.ts reads the editor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/store/call-team/route.ts", "utf8");
const editor = readFileSync("components/team-event-editor.tsx", "utf8");

test("the route answers an unconfirmed team save as unavailable", () => {
  assert.match(route, /error: "unavailable" \}, \{ status: 503 \}/);
});

test("the editor shows its own honest words for unavailable, not the server_error fallback", () => {
  const entry = editor.match(/\n  unavailable: "([^"]+)",\n/);
  assert.ok(entry, "components/team-event-editor.tsx MESSAGES has no unavailable entry");
  const words = entry[1];
  assert.doesNotMatch(words, /nothing was saved/i);
  assert.match(words, /could not confirm/i);
  assert.match(words, /reload the page/i);
});
