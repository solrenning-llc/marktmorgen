/**
 * 639 [GL7](6), unit 2: tasks on a person's page in the studio
 * (components/person-tasks.tsx, app/studio/people/page.tsx). Each task a
 * checkbox named by its own words, done said in words as well as by the
 * line, dates read as the dates they are, every field labeled, refusals in
 * an alert, and the add form gone at the most a person can have.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonTasks } from "@/components/person-tasks";
import { MAX_PERSON_TASKS, type PersonTask } from "@/lib/person-tasks";
import { done, is, part } from "./check";

const PERSON = "a".repeat(32);
const task = (n: number, over: Partial<PersonTask> = {}): PersonTask => ({ id: `task${String(n).padStart(6, "0")}`, text: `Task ${n}`, due: "", assignee: "", done: false, createdAt: 1, doneAt: 0, ...over });
const draw = (tasks: PersonTask[]) => renderToStaticMarkup(createElement(PersonTasks, { person: PERSON, initial: tasks, assignees: ["owner@example.com", "sam@example.com"], today: "2026-11-03" }));

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

part("On the person's page");
const page = readFileSync("app/studio/people/page.tsx", "utf8");
is("a named section with its heading", page.includes('aria-labelledby="tasks-title"') && page.includes('<h2 id="tasks-title"'), true);
is("read with the person's page, and said when they cannot be read", page.includes("readPersonTasks(store.statsId, profile.person)") && page.includes("tasks could not be read just now"), true);
is("the teammates offered are those who can see orders", page.includes('filter((m) => can(m.role, "orders"))'), true);

done();
