/**
 * A community room says new messages to a screen reader as they come
 * (components/community-room.tsx; WCAG 4.1.3, read the more accessible way as
 * 274 [AX1] item 4 asks: dynamic notices in live regions).
 *
 * The room asks for new messages every few seconds. The list of messages is
 * a live log (role="log", polite, additions only), named by the page's own
 * heading, so a member who cannot see the screen learns that someone
 * answered, without the messages already there being read again.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityRoom } from "@/components/community-room";
import { roomWords } from "@/lib/buyer-words/community";
import { done, is, part } from "./check";

const words = roomWords("en", "en-US", { live: 5, idle: 30, away: 10, kept: 500 });
const props = {
  handle: "harbor",
  room: "c0000000001",
  first: [{ i: 1, a: "m1", text: "Hello, room", at: 1_700_000_000 }],
  names: { m1: "Ana" },
  cursor: 1,
  me: "m2",
  creator: "creator",
  creatorName: "Harbor Kitchen",
  canWrite: true,
  owner: false,
  creatorOnly: false,
  slow: 0,
  links: false,
  leave: null,
  resting: false,
  quiet: 0,
  labelledBy: "room-title",
  words,
};

part("The messages are a live log named by the room's heading");
const html = renderToStaticMarkup(createElement(CommunityRoom, props));
const log = /<div role="log" aria-live="polite" aria-relevant="additions" aria-labelledby="room-title">\s*<ul[^>]*class="cm-room"/.exec(html);
is("a polite log of additions holds the list", Boolean(log), true);
const logStart = html.indexOf('role="log"');
const messageAt = html.indexOf("Hello, room");
const formAt = html.indexOf("<form");
is("the messages are inside it, the box to write is not", [logStart >= 0 && messageAt > logStart, formAt > messageAt], [true, true]);
is("only one log on the page", html.split('role="log"').length - 1, 1);

part("The page gives the heading the id the log names");
const page = readFileSync("app/[handle]/community/chat/page.tsx", "utf8");
is("the heading has the id", /<h1 id="room-title"[^>]*>\{w\.theRoom\}<\/h1>/.test(page), true);
is("and the room is told it", /labelledBy="room-title"/.test(page), true);

done();
