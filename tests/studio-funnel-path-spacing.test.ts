/**
 * The funnel editor (components/funnel-editor.tsx) draws "The path" as a row:
 * the product a buyer paid for, as a badge, then the word "paid". The row was a
 * flex line that could not wrap, so with the text spacing of WCAG 2.2 1.4.12
 * (AX274 Part A item 4) at 320 px wide, /studio/funnels scrolled sideways by
 * 39 px. The row now wraps, so "paid" moves under the badge when there is no room.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const editor = readFileSync("components/funnel-editor.tsx", "utf8");
const at = editor.indexOf('<span className="text-ink-mute">paid</span>');
const badge = editor.lastIndexOf("{/* A badge, not a button", at);
const row = /<div className="([^"]*)">\s*$/.exec(editor.slice(editor.lastIndexOf("<div", badge), badge))?.[1] ?? "";

is("the path still starts with the paid product and the word paid", at > 0 && badge > 0, true);
is("the row is a flex row", /\bflex\b/.test(row), true);
is("the row wraps when the text needs more room", /\bflex-wrap\b/.test(row), true);

// Review of #3798: a long product title (cut at 12rem) and a long price made the badge alone wider than a 320px
// screen, so the row overflowed even when it wrapped (Chromium: 348-373 px). The badge never grows past its row; the
// title gives way (min-w-0) and the price keeps its width (shrink-0).
const badgeOpen = editor.indexOf("<span", badge);
const badgeClass = /className="([^"]*)"/.exec(editor.slice(badgeOpen, editor.indexOf(">", badgeOpen)))?.[1] ?? "";
is("the badge is never wider than its row", /\bmax-w-full\b/.test(badgeClass), true);
is("a long title gives way inside the badge", editor.includes('<span className="min-w-0 max-w-[12rem] truncate">{owner.title}</span>'), true);
is("the price keeps its width", editor.includes('<span className="shrink-0 text-ink-mute">{ownerPrice}</span>'), true);

done();
