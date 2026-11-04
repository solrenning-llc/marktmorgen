/**
 * 639 [GL7](6), unit 2: tasks on a person's page in the studio
 * (components/person-tasks.tsx, app/studio/people/page.tsx). Each task a
 * checkbox named by its own words, done said in words as well as by the
 * line, dates read as the dates they are, every field labeled, refusals in
 * an alert, a removal undone from a status line, and the add form gone at
 * the most a person can have.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonTasks, browserDay } from "@/components/person-tasks";
import { MAX_PERSON_TASKS, type PersonTask, dayIn } from "@/lib/person-tasks";
import { done, is, part } from "./check";

const PERSON = "a".repeat(32);
const task = (n: number, over: Partial<PersonTask> = {}): PersonTask => ({ id: `task${String(n).padStart(6, "0")}`, text: `Task ${n}`, due: "", assignee: "", done: false, createdAt: 1, doneAt: 0, ...over });
const draw = (tasks: PersonTask[], today = "2026-11-03") => renderToStaticMarkup(createElement(PersonTasks, { person: PERSON, initial: tasks, assignees: ["owner@example.com", "sam@example.com"], today }));

part("Each task");
const html = draw([task(1, { text: "Send the workbook", due: "2026-11-01", assignee: "sam@example.com" }), task(2, { text: "Book the call", due: "2026-11-10" }), task(3, { text: "Say thanks", done: true })]);
is("how many are open and done", html.includes("2 open, 1 done."), true);
is("a checkbox named by the task's own words", /<label[^>]*><input type="checkbox"[^>]*\/><span[^>]*>Send the workbook/.test(html), true);
is("done is said in words, not only by the line", html.includes('Say thanks<span class="sr-only"> (done)</span>'), true);
is("a date past is said as past, the calendar date as typed", html.includes("Was due Nov 1, 2026") && html.includes("Due Nov 10, 2026"), true);
is("who is responsible, or nobody", html.includes("· sam@example.com") && html.includes("· Nobody named"), true);
is("each remove button says which task", html.includes('aria-label="Remove the task: Book the call"'), true);
is("rows tall enough to tap", html.includes("min-h-11"), true);

part("Adding one");
is("every field labeled, the date and teammate optional", ["New task", "Due (optional)", "Responsible (optional)"].every((label) => html.includes(label)), true);
is("the teammates who can see deals, or nobody", /<option value=""[^>]*>Nobody<\/option>/.test(html) && /<option value="sam@example.com"[^>]*>sam@example.com<\/option>/.test(html), true);
is("the length counted beside the field", html.includes('aria-describedby="task-length"') && html.includes("0/200"), true);
is("refusals are said in an alert region", html.includes('role="alert"'), true);
const full = draw(Array.from({ length: MAX_PERSON_TASKS }, (_, i) => task(i + 1)));
is("at the most a person can have, the form says so instead", [full.includes("New task"), full.includes(`This person has ${MAX_PERSON_TASKS} tasks`)], [false, true]);
is("none yet", draw([]).includes("No tasks yet."), true);

part("Undoing a removal");
const source = readFileSync("components/person-tasks.tsx", "utf8");
is("a status region, there before anything is removed, says what was removed", html.includes('<div role="status"') && source.includes("`Removed: ${removed.text}`"), true);
is("undo puts back the words, the date and the teammate", source.includes('{ action: "add", text: task.text, due: task.due, assignee: task.assignee }'), true);
is("and marks it done again if it was", source.includes('if (task.done && added) await send({ action: "done", id: added.id, done: true }'), true);
is("offered only after the removal was saved", source.includes('if (await send({ action: "remove", id: task.id }, "Task removed.")) setRemoved(task);'), true);

part("On the person's page");
const page = readFileSync("app/studio/people/page.tsx", "utf8");
is("a named section with its heading", page.includes('aria-labelledby="tasks-title"') && page.includes('<h2 id="tasks-title"'), true);
is("read with the person's page, and said when they cannot be read", page.includes("readPersonTasks(store.statsId, profile.person)") && page.includes("tasks could not be read just now"), true);
is("the teammates offered are those who can see orders", page.includes('filter((m) => can(m.role, "orders"))'), true);

part("The creator's own day, not the server's");
// 01:30 UTC on 4 November is 22:30 on 3 November in Fortaleza (UTC-3).
const LATE_EVENING = Date.parse("2026-11-04T01:30:00Z");
is("the day in Fortaleza is still the 3rd", dayIn(LATE_EVENING, "America/Fortaleza"), "2026-11-03");
is("in UTC it is already the 4th", dayIn(LATE_EVENING, "UTC"), "2026-11-04");
is("a zone the runtime does not know reads as UTC", [dayIn(LATE_EVENING, "Not/A_Zone"), dayIn(LATE_EVENING, "")], ["2026-11-04", "2026-11-04"]);
const zoneBefore = process.env.TZ;
process.env.TZ = "America/Fortaleza";
const there = browserDay(LATE_EVENING);
if (zoneBefore === undefined) delete process.env.TZ;
else process.env.TZ = zoneBefore;
is("a browser in Fortaleza reads the 3rd", there, "2026-11-03");
const evening = draw([task(1, { text: "Call back", due: "2026-11-03" }), task(2, { text: "Send the file", due: "2026-11-04" }), task(3, { text: "Pay the editor", due: "2026-11-02" })], there);
is("a task due that day is due, not past", [evening.includes("Due Nov 3, 2026"), evening.includes("Was due Nov 3, 2026")], [true, false]);
is("tomorrow's is still to come, yesterday's past", [evening.includes("Due Nov 4, 2026"), evening.includes("Was due Nov 2, 2026")], [true, true]);
is("the browser's day takes over after the server's drawing, which it never mismatches", source.includes("useSyncExternalStore(noSubscription, () => browserDay(), () => serverDay)") && source.includes("const today = useCreatorDay(serverDay);"), true);

done();
