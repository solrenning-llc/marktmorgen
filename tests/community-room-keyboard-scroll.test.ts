/**
 * A community room's messages (components/community-room.tsx) sit in a box of their own height that scrolls
 * (.cm-room, overflow-y: auto). A member who is not the creator has nothing focusable inside it (no Remove
 * buttons), so in a browser that does not make scrolling boxes focusable by itself (Safari) the earlier messages
 * could not be reached from the keyboard at all. WCAG 2.2 2.1.1 Keyboard (A), 2.1.3 Keyboard (No Exception, AAA),
 * 2.4.7 and 2.4.13 for the focus it then takes. 274 [AX1].
 *
 * Found reading the code on 13 November 2026 (buyer AAA audit, the member's community chat).
 *
 * Holds: the box is in the tab order (tabIndex 0) for every reader, so arrow keys and Page Up/Down scroll it;
 * and the stylesheet draws a visible focus ring on it, the same 3 px accent ring as the community's other
 * controls. Synthetic props; no network.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommunityRoom } from "@/components/community-room";
import { roomWords } from "@/lib/buyer-words/community";
import { done, is, part } from "./check";

type Props = Parameters<typeof CommunityRoom>[0];

const base: Props = {
  handle: "school",
  room: "r".repeat(12),
  first: [
    { i: 1, a: "creator", text: "Welcome, everyone.", at: 1_790_000_000 },
    { i: 2, a: "m1", text: "Hello!", at: 1_790_000_060 },
  ],
  names: { creator: "Ada", m1: "Ben" },
  cursor: 2,
  me: "m2",
  creator: "creator",
  creatorName: "Ada",
  canWrite: true,
  owner: false,
  creatorOnly: false,
  slow: 0,
  links: true,
  leave: null,
  resting: false,
  quiet: 30,
  words: roomWords("en", "en-US", { live: 5, idle: 30, away: 10, kept: 500 }),
};

const roomTag = (props: Props) => renderToStaticMarkup(createElement(CommunityRoom, props)).match(/<ul[^>]*class="cm-room"[^>]*>/)?.[0] ?? "";

part("2.1.1: the scrolling box of messages is reachable from the keyboard");
for (const [who, props] of [
  ["a member, with nothing focusable inside", base],
  ["the creator", { ...base, owner: true, me: "creator" }],
  ["an empty room", { ...base, first: [] }],
] as const) {
  const tag = roomTag(props);
  is(`${who}: the box is drawn`, Boolean(tag), true);
  is(`${who}: it is in the tab order`, /\stabindex="0"/.test(tag), true);
}

part("2.4.7 and 2.4.13: the box shows where the focus is");
const css = readFileSync("app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(",").map((s) => s.trim()), body: m[2] }));
const ring = rules.find((r) => r.selectors.includes(".cm-room:focus-visible"));
is("a rule for the focused box exists", Boolean(ring), true);
is("it draws a 3px solid outline in the accent's text colour", /outline:\s*3px solid var\(--st-accent-text\)/.test(ring?.body ?? ""), true);
done();
