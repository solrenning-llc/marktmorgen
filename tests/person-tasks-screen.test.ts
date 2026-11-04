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
import { PersonTasks, addedTask, browserDay, staleRefusal, undoBody, undoWords, untilNextDay, watchDay } from "@/components/person-tasks";
import { MAX_PERSON_TASKS, type PersonTask, dayIn, readTaskInput } from "@/lib/person-tasks";
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
const gone = task(7, { text: "Send the slides", due: "2026-11-05", assignee: "sam@example.com", done: true });
is("undo puts back the words, the date and the teammate", undoBody(gone, ["owner@example.com", "sam@example.com"]), { body: { action: "add", text: "Send the slides", due: "2026-11-05", assignee: "sam@example.com" }, unassigned: false });
is("a teammate who left since: the task comes back with nobody named, and it is said, instead of not coming back", [undoBody(gone, ["owner@example.com"]), source.includes("const { body, unassigned } = undoBody(task, assignees);") && source.includes("can no longer be responsible for tasks")], [{ body: { action: "add", text: "Send the slides", due: "2026-11-05", assignee: "" }, unassigned: true }, true]);
is("the task put back is the one this add made, never one another tab added at the same moment", [addedTask([task(1)], [task(1), task(9)])?.id, source.includes("const added = addedTask(before, back, { text: String(body.text), due: String(body.due), assignee: String(body.assignee) });")], ["task000009", true]);
const sent = { text: "Send the slides", due: "2026-11-05", assignee: "" };
const theirs = task(8, { text: "Call Ana" });
const ours = task(9, { text: "Send the slides", due: "2026-11-05" });
is("two new at once (round 2, A-M): the one with the words, date and teammate sent, wherever it is", [addedTask([task(1)], [task(1), ours, theirs], sent)?.id, addedTask([task(1)], [task(1), theirs, ours], sent)?.id], ["task000009", "task000009"]);
is("and none only when no new one has them", [addedTask([task(1)], [task(1), theirs, task(7, { text: "Other" })], sent), addedTask([task(1)], [task(1), theirs, ours])], [null, null]);
is("and marks it done again if it was", source.includes('await send({ action: "done", id: added.id, done: true }, undoWords(task, unassigned, true));'), true);
is("said once, all of it in one message (round 2, A-L)", [undoWords(gone, true, true), undoWords({ ...gone, done: false }, false, null), source.includes("const back = await send(body, task.done ? null : undoWords(task, unassigned, null));")], ["Task put back with nobody named, since sam@example.com can no longer be responsible for tasks. Marked done again.", "Task put back.", true]);
is("and when the task put back cannot be told apart, it says it is open, briefly", [undoWords(gone, false, false), source.includes("if (!added) return toast(undoWords(task, unassigned, false));")], ["Task put back. It is open: mark it done if it still is.", true]);
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
is("the browser's day takes over after the server's drawing, which it never mismatches", source.includes("useSyncExternalStore(watchBrowserDay, () => browserDay(), () => serverDay)") && source.includes("const today = useCreatorDay(serverDay);"), true);

part("A page left open past midnight (edge review)");
process.env.TZ = "America/Fortaleza";
is("the next day starts a second past midnight where the browser is", untilNextDay(Date.parse("2026-11-04T02:30:00Z")), 30 * 60 * 1_000 + 1_000);
const timers: { run: () => void; ms: number; live: boolean }[] = [];
const heard: (() => void)[] = [];
let changes = 0;
const stopWatching = watchDay(() => { changes += 1; }, {
  now: () => Date.parse("2026-11-04T02:30:00Z"),
  setTimer: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer; },
  clearTimer: (timer) => { if (timer) (timer as { live: boolean }).live = false; },
  listen: (run) => { heard.push(run); return () => heard.splice(heard.indexOf(run), 1); },
});
is("it waits for that midnight", [timers.length, timers[0].ms], [1, 30 * 60 * 1_000 + 1_000]);
timers[0].run();
is("at midnight the day is read again, and the next midnight awaited, one timer at a time", [changes, timers.length, timers.filter((t) => t.live).length], [1, 2, 1]);
heard[0]();
is("and again when the page is seen again (a laptop opened the next morning)", [changes, timers.length, timers.filter((t) => t.live).length], [2, 3, 1]);
stopWatching();
is("nothing is left waiting once the page is closed", [timers.some((t) => t.live), heard.length], [false, 0]);
if (zoneBefore === undefined) delete process.env.TZ;
else process.env.TZ = zoneBefore;

part("A screen another tab changed (edge review)");
is("a task gone, a list filled or a teammate gone elsewhere says this screen is out of date", ["unknown", "full", "store_full", "assignee", "text", "long", "date", undefined].map(staleRefusal), [true, true, true, true, false, false, false, false]);
is("then the tasks are read again, so what is shown is what is kept, and the refusal says so", source.includes("staleRefusal(answer.error) && (await reread())") && source.includes("/api/store/person-tasks?person=${encodeURIComponent(person)}") && source.includes("The list now shows the tasks as they are."), true);

part("Words no one can see (edge review)");
const typed = (text: string) => { const r = readTaskInput({ text }, () => true); return r.ok ? r.value.text : r.error; };
is("only zero-width spaces, joiners or fillers are no task", ["\u200b\u200b", "\u2060", "\u3164", "\u200d", "\u0301"].map(typed), ["text", "text", "text", "text", "text"]);
is("words shown backwards lose their direction signs", typed("\u202eCall Ana"), "Call Ana");
is("half a character pair is shown as the replacement sign", typed("A\ud800B"), "A\ufffdB");
is("C1 controls are made spaces, an accent typed as two characters kept as one", [typed("a\u0085b"), typed("Cafe\u0301")], ["a b", "Caf\u00e9"]);
is("emoji joined by a joiner stay as typed", typed("Thank \u{1F469}\u200d\u{1F4BB}"), "Thank \u{1F469}\u200d\u{1F4BB}");
part("Signs no one sees, as the sequence import takes them out (round 2, A-L)");
is("a soft hyphen, a zero-width space and the direction marks go", typed("Ca\u00adll\u200b A\u200en\u200fa"), "Call Ana");
is("the joiners stay on purpose (Persian, the Indic scripts, emoji)", [typed("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645"), typed("a\u200db")], ["\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "a\u200db"]);
is("tag characters, which can carry words no one sees, go", [typed("Call Ana\u{E0068}\u{E0069}\u{E0064}"), typed("Only\u{E007F}")], ["Call Ana", "Only"]);
const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
is("except inside a flag of a region, kept whole", typed(`Visit ${scotland}`), `Visit ${scotland}`);
is("words of tag characters only are no task", typed("\u{E0068}\u{E0069}"), "text");

done();
