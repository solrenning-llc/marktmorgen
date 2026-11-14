/**
 * AX274, WCAG 3.3.6 Error Prevention (All) at AAA: removing something the creator
 * typed or connected either asks first or can be undone. The studio audit of
 * 13 November 2026 found six removals that did neither, acting on the first press:
 * a note on the numbers, a note on a person's page, a saved inbox reply, a typed
 * ad spend, the private iCal address of the host calendar and a connected
 * calendar feed. Each now goes through ConfirmAction (components/confirm-action.tsx,
 * the mechanism of 568 [GD2] (h)): the first press asks what will happen; only
 * "Yes, remove" does it; "Keep it", focused, puts it back.
 *
 * What fails here: one of the six acting on its first press again, or asking
 * without saying what is removed.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");

part("Each of the six asks before it removes");
for (const [file, question, firstPress] of [
  ["components/numbers-notes.tsx", "Remove this note?", /onClick=\{\(\) => void send\(\{ action: "remove", id: note\.id \}/],
  ["components/person-notes.tsx", "Remove this note?", /onClick=\{\(\) => void send\(\{ action: "unnote", id: note\.id \}/],
  ["components/inbox-studio.tsx", "Remove this saved reply?", /onClick=\{\(\) => onSave\(saved\.filter\(\(x\) => x\.id !== s\.id\), "Removed\."\)\}/],
  ["components/ad-spend-editor.tsx", "Remove this spend?", /onClick=\{\(\) => void send\(\{ action: "remove", id: spend\.id \}/],
  ["components/host-calendar.tsx", "Remove this calendar address?", /onClick=\{\(\) => send\("ics-remove", \{\}, "Calendar address removed\."\)\}/],
  ["components/calendar-editor.tsx", "Remove this calendar?", /onClick=\{\(\) => send\("remove", \{ id: feed\.id \}\)\}/],
] as const) {
  const text = read(file);
  is(`${file}: the first press no longer removes`, firstPress.test(text), false);
  is(`${file}: through ConfirmAction, saying what is removed`, text.includes("<ConfirmAction") && text.includes(question) && /yes="Yes, remove"/.test(text), true);
  is(`${file}: imports the shared ConfirmAction`, /import \{ ConfirmAction \} from "@\/components\/confirm-action";/.test(text), true);
}

done();
