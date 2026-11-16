/**
 * 485 [IT2], unit 3 (added 16 November 2026): the community events studio
 * asks on the page itself, never in the browser's own dialog, before what
 * cannot be undone: canceling an event (everyone coming is emailed once),
 * deleting a canceled event for good, and deleting a past event with its
 * replay link for good. What happens is written on the buttons ("Yes, cancel
 * the event" and "Keep the event"; "Yes, delete for good" and "Keep it"), the
 * safe choice takes the focus, and only the second press acts. After a delete
 * the row is gone, so the focus goes to the section's heading (2.4.3), never
 * to the top of the page.
 *
 * What fails here: a browser confirmation coming back, a press that acts at
 * once, a question that no longer says what it costs, or the shared
 * ConfirmAction losing its default "Keep it".
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmAction } from "@/components/confirm-action";
import { done, is, part } from "./check";

const flat = (file: string) => readFileSync(file, "utf8").replace(/\s+/g, " ");

part("The shared question");
const confirmAction = flat("components/confirm-action.tsx");
is("the safe choice keeps its words, and says what it keeps where a caller names it", [confirmAction.includes('keep = "Keep it"'), confirmAction.includes("autoFocus onClick={() => setAsking(false)}> {keep} </button>")], [true, true]);
is("the first press only asks: nothing is done before the question", renderToStaticMarkup(createElement(ConfirmAction, { question: "Delete it?", yes: "Yes, delete", onConfirm: () => undefined } as Parameters<typeof ConfirmAction>[0], "Delete")).includes("Delete it?"), false);

part("The events studio");
const events = flat("components/community-events-studio.tsx");
is("no browser dialog is left in it", events.includes("window.confirm"), false);
is("canceling asks on the page, saying who is emailed and that it cannot be undone", [
  events.includes('cancelQuestion={`Cancel "${event.title}"?${cancelWho(event)} This cannot be undone.`}'),
  events.includes('<ConfirmAction className={small} disabled={busy !== null} busy={busy === `e-${event.id}`} question={cancelQuestion} yes="Yes, cancel the event" keep="Keep the event" onConfirm={onCancelEvent}> Cancel the event </ConfirmAction>'),
], [true, true]);
is("deleting asks on the page, and a past event's question names its replay link", [
  events.includes('deleteQuestion={`Delete "${event.title}" for good?`}'),
  events.includes('deleteQuestion={`Delete "${event.title}" and its replay link for good?`}'),
  events.includes('<ConfirmAction className={small} disabled={busy !== null} busy={busy === `e-${event.id}`} question={deleteQuestion} yes="Yes, delete for good" onConfirm={onDelete}> Delete </ConfirmAction>'),
], [true, true, true]);
is("the same requests as before, on the second press only", [
  events.includes('run(`e-${event.id}`, { action: "cancel", event: event.id }'),
  (events.match(/deleteEvent\(event\)/g) ?? []).length,
  events.includes('const ok = await run(`e-${event.id}`, { action: "delete", event: event.id }, "Deleted."); if (ok) deleted.current = event.id;'),
], [true, 2, true]);
is("after a delete the focus goes to the section's heading, which can take it", [
  events.includes('if (id === null || events.some((e) => e.id === id) || past.some((e) => e.id === id)) return; deleted.current = null; document.getElementById("cm-events-title")?.focus();'),
  events.includes('<h2 id="cm-events-title" tabIndex={-1}'),
], [true, true]);

done();
