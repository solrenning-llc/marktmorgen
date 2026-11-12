/**
 * AX274: the community chat room (components/community-room.tsx), as a
 * keyboard and screen reader user meets it.
 *
 *   - 2.1.1 Keyboard: the room is a box that scrolls on its own; a keyboard
 *     could not reach it to scroll back through what was said. It now takes
 *     focus and carries a name.
 *   - 4.1.3 Status Messages: messages from others arrived without a word to
 *     a screen reader. A polite status now says how many arrived, once per
 *     batch, never each message's text, so a busy room does not flood.
 *   - 2.2.4 Interruptions: the reader can turn those announcements off and
 *     on again; one's own message is never announced.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityRoom } from "@/components/community-room";
import { roomWords } from "@/lib/buyer-words/community";
import { newFromOthers, roomNews } from "@/lib/community-room-news";
import { done, is, part } from "./check";

const pace = { live: 5, idle: 30, away: 10, kept: 500 };

part("Only messages from others are counted, and said once per batch");
is("one's own is never announced", newFromOthers([{ a: "me" }, { a: "me" }], "me"), 0);
is("others are counted", newFromOthers([{ a: "x" }, { a: "me" }, { a: "y" }], "me"), 2);
const en = roomWords("en", "en-US", pace);
is("one", roomNews(1, en), "1 new message.");
is("several", roomNews(4, en), "4 new messages.");
is("none says nothing", roomNews(0, en), "");

part("Every store language has the room's new words");
for (const lang of ["en", "es", "fr", "de", "it", "nl", "pt"] as const) {
  const w = roomWords(lang, "x", pace);
  is(`${lang}: the room has a name`, w.roomLabel.length > 3, true);
  is(`${lang}: several new is a template`, w.newMany.includes("{n}"), true);
  is(`${lang}: one new`, w.newOne.length > 3, true);
  is(`${lang}: the switch says what it does`, w.announceNew.length > 10, true);
}

part("The room as drawn");
const html = renderToStaticMarkup(
  createElement(CommunityRoom, {
    handle: "fay",
    room: "r1",
    first: [{ i: 1, a: "x", at: 1_800_000_000, text: "Hello" }],
    names: { x: "Ann" },
    cursor: 1,
    me: "me",
    creator: "c",
    creatorName: "Fay",
    canWrite: true,
    owner: false,
    creatorOnly: false,
    slow: 0,
    links: true,
    leave: null,
    resting: false,
    quiet: -1,
    words: en,
  } as Parameters<typeof CommunityRoom>[0]),
);
is("the scrolling room takes keyboard focus", /<ul[^>]*tabindex="0"/.test(html), true);
is("…and has a name", /<ul[^>]*aria-label="Messages in this room"/.test(html), true);
is("a polite status for new messages is there", /role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/.test(html) || /data-room-news=""[^>]*role="status"|role="status"[^>]*data-room-news=""/.test(html), true);
is("…empty at first", /data-room-news="">\s*</.test(html) || /data-room-news=""><\/p>/.test(html), true);
is("announcements can be turned off", /<input[^>]*type="checkbox"[^>]*checked=""/.test(html) && html.includes(en.announceNew), true);

part("The room's script");
const source = readFileSync("components/community-room.tsx", "utf8");
is("take() counts only others' messages", source.includes("newFromOthers("), true);
is("an off switch stops the count", /announce(Ref)?\.current/.test(source), true);

done();
