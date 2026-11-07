/**
 * The call editor's sessions and weekly hours: every control a thumb has to
 * find is at least 44 by 44 pixels (WCAG 2.5.5), and adding or removing a
 * session or a second stretch never drops the keyboard's focus onto the page
 * (WCAG 2.4.3). Added 7 November 2026.
 *
 * Found in components/call-editor.tsx: the two "×" buttons were 32px
 * (h-8 w-8); the date, time, length, seats and link fields of each session and
 * the two clocks of each stretch overrode .field's 48px floor with !min-h-0,
 * which left them about 36px tall; "Add a second stretch" had no height of its
 * own (about 20px), and so did each day's on/off label. Removing a session or a
 * second stretch took away the very button that had the focus, and so did
 * adding a second stretch (a day holds at most two) or the last session
 * allowed: the focus fell to the page's body, and a keyboard or screen reader
 * user had to start again from the top. The other lengths, in the same editor,
 * already moved the focus; these did not.
 *
 * Read in the source: these rows are drawn only inside the open editor, which
 * a page drawn on the server never shows open. Not checked here (needs a
 * browser): the measured boxes and the real focus.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { focusAfterRemoval } from "@/lib/block-insert";

const source = readFileSync("components/call-editor.tsx", "utf8");

/** The whole <button …>…</button> element whose text or attributes contain `marker`. */
function buttonAround(marker: string): string {
  const at = source.indexOf(marker);
  if (at < 0) return "";
  const start = source.lastIndexOf("<button", at);
  const end = source.indexOf("</button>", at);
  return start < 0 || end < 0 ? "" : source.slice(start, end + "</button>".length);
}

/** A template id with each `${…}` blanked, so `${s.id}` and `${added.id}` read as the same place. */
const shape = (template: string) => template.replace(/\$\{[^}]*\}/g, "${}");
const ids = new Set([...source.matchAll(/\bid=\{`([^`]+)`\}/g)].map((m) => shape(m[1])));

/** Every focusSoon(`…`) in a handler names an id that the editor really draws. */
function focusTargets(block: string): { called: boolean; drawn: boolean } {
  const targets = [...block.matchAll(/focusSoon\(`([^`]+)`\)/g)].map((m) => shape(m[1]));
  return { called: targets.length > 0, drawn: targets.length > 0 && targets.every((t) => ids.has(t)) };
}

const classOf = (block: string) => block.match(/className="([^"]+)"/)?.[1]?.split(/\s+/) ?? [];
const tall = (classes: string[]) => classes.some((c) => /^(min-)?h-(1[1-9]|[2-9]\d)$/.test(c)) || classes.includes("btn");
const wide = (classes: string[]) => classes.some((c) => /^(min-)?w-(1[1-9]|[2-9]\d)$/.test(c)) || !classes.some((c) => /^w-\d+$/.test(c));

part("Targets of at least 44 by 44 (2.5.5)");
const removeSession = buttonAround("aria-label={`Remove session ${index + 1}`}");
const removeStretch = buttonAround("aria-label={`Remove ${name}'s second stretch`}");
const addSession = buttonAround("Add a session");
const addStretch = buttonAround("Add a second stretch");
is("the four buttons are where they were", [removeSession, removeStretch, addSession, addStretch].map((b) => b.length > 0), [true, true, true, true]);
is("removing a session: at least 44px tall and wide", [tall(classOf(removeSession)), wide(classOf(removeSession))], [true, true]);
is("removing a second stretch: at least 44px tall and wide", [tall(classOf(removeStretch)), wide(classOf(removeStretch))], [true, true]);
is("adding a session: at least 44px tall", tall(classOf(addSession)), true);
is("adding a second stretch: at least 44px tall", tall(classOf(addStretch)), true);
// .field is 48px tall (app/globals.css); a field that lowers it below 44 is a target too small to find.
const lowered = [...source.matchAll(/className="(field[^"]*)"/g)].map((m) => m[1]).filter((c) => /!min-h-(0|[1-9]|10)\b|!h-(\d|10)\b/.test(c));
is("no field lowers .field's height below 44px", lowered, []);
const dayLabel = source.match(/<label className="([^"]*)">\s*<input\s+type="checkbox"\s+checked=\{on\}/)?.[1]?.split(/\s+/) ?? [];
is("each day's on/off label, the target of its small checkbox, is at least 44px tall", [dayLabel.length > 0, tall(dayLabel)], [true, true]);

part("Focus follows the change (2.4.3)");
is("removing a session moves the focus to a field the editor draws", focusTargets(removeSession), { called: true, drawn: true });
is("adding a session moves the focus to the new session's first field", focusTargets(addSession), { called: true, drawn: true });
is("removing a second stretch moves the focus to the day's first clock", focusTargets(removeStretch), { called: true, drawn: true });
is("adding a second stretch moves the focus to its first clock", focusTargets(addStretch), { called: true, drawn: true });
is("the session moved to after a removal is the one now in its place, else the one before it", /focusAfterRemoval\(index, sessions\.length\)/.test(removeSession), true);
is("rows are found by their own key, not their place, so a removal never focuses a stale row", /focusSoon\(`call-\$\{product\.id\}-session-\$\{sessions\[at\]\.id\}-date`\)/.test(removeSession), true);
// Shared with the other lengths: a field drawn a frame late still gets the focus (lib/focus-when-drawn.ts).
is("focus waits for the field to be drawn, as the page editor's does", /const focusSoon = \(target: string\) =>[\s\S]{0,120}focusWhenDrawn\(\(\) => document\.getElementById\(target\), browserFrames\(\)\)/.test(source), true);
is("the other lengths keep their focus moves", [source.includes("focusSoon(`length-${id}-${added.id}`)"), source.includes("focusSoon(`lengths-hint-${id}`)")], [true, true]);

part("The rule itself");
is("removing the first of three goes to the new first; the last of three to the one before", [focusAfterRemoval(0, 2), focusAfterRemoval(2, 2), focusAfterRemoval(1, 2)], [0, 1, 1]);

done();
