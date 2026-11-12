import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { CommunityRoom } from "@/components/community-room";
import { roomWords } from "@/lib/buyer-words/community";

// Issue #3993 (WCAG 4.1.3 Status Messages): the room polls for new messages,
// so its list must be a polite log a screen reader announces additions from,
// named by the room page's heading (id "room-title"), without taking focus or rereading the history.
function render(language: string, first: { i: number; a: string; text: string; at: number }[]) {
  return renderToStaticMarkup(createElement(CommunityRoom, {
    handle: "example", room: "room-1", first, names: { other: "Ana" }, cursor: first.length ? first[first.length - 1].i : 0,
    me: "me", creator: "creator", creatorName: "Creator", canWrite: true, owner: false, creatorOnly: false,
    slow: 0, links: false, leave: null, resting: false, quiet: -1,
    words: roomWords(language, "en-US", { live: 5, idle: 30, away: 20, kept: 500 }),
  }));
}

const listTag = (html: string) => html.match(/<ul[^>]*class="cm-room"[^>]*>/)?.[0] ?? "";

test("the room's message list is a polite log named by the room", () => {
  const ul = listTag(render("en", [{ i: 1, a: "other", text: "Hello there", at: 1_800_000_000 }]));
  assert.ok(ul, "the message list is drawn");
  assert.match(ul, /role="log"/);
  assert.match(ul, /aria-live="polite"/);
  assert.match(ul, /aria-relevant="additions"/);
  assert.ok(ul.includes('aria-labelledby="room-title"'), "named by the page's heading");
  assert.doesNotMatch(ul, /aria-atomic="true"/, "an atomic log would read the whole history on every message");
  assert.doesNotMatch(ul, /tabindex|autofocus/i, "announcing never moves focus");
});

test("the log is named by the room page's heading, in the store's language", () => {
  assert.ok(listTag(render("es", [])).includes('aria-labelledby="room-title"'));
  // The chat page's <h1> (the room's name, w.theRoom, already in every language) carries that id.
  const page = readFileSync("app/[handle]/community/chat/page.tsx", "utf8");
  assert.match(page, /<h1 id="room-title"[^>]*>\{w\.theRoom\}<\/h1>/);
});
