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
import { PersonTasks, TEAM_UNREAD, addedTask, alertWords, browserDay, focusAfter, focusTarget, putBack, refusalOf, staleRefusal, undoBody, undoWords, untilNextDay, watchDay } from "@/components/person-tasks";
import { MAX_PERSON_TASKS, type PersonTask, dayIn, readTaskInput, taskAssignees } from "@/lib/person-tasks";
import { done, is, part } from "./check";

const PERSON = "a".repeat(32);
const task = (n: number, over: Partial<PersonTask> = {}): PersonTask => ({ id: `task${String(n).padStart(6, "0")}`, text: `Task ${n}`, due: "", assignee: "", done: false, createdAt: 1, doneAt: 0, ...over });
const draw = (tasks: PersonTask[], today = "2026-11-03", assignees: string[] | null = ["owner@example.com", "sam@example.com"]) => renderToStaticMarkup(createElement(PersonTasks, { person: PERSON, initial: tasks, owner: "owner@example.com", assignees, today, preparedAt: 1 }));

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
is("every field labeled, the date and teammate optional", [["text", "New task"], ["due", "Due (optional)"], ["assignee", "Responsible (optional)"]].every(([id, label]) => html.includes(`<label for="task-${id}" class="field-label">${label}</label>`) && html.includes(`id="task-${id}"`)), true);
is("the example stays while typing, never a placeholder (3.3.2)", html.includes("Example: Send the workbook.") && !html.includes("placeholder="), true);
is("the teammates who can see deals, or nobody", /<option value=""[^>]*>Nobody<\/option>/.test(html) && /<option value="sam@example.com"[^>]*>sam@example.com<\/option>/.test(html), true);
is("the length counted beside the field, in words", html.includes('aria-describedby="task-hint task-length"') && html.includes("0 of 200 characters") && !html.includes("0/200"), true);
is("no box or button switched off, so the focus never falls off one (C1, C3)", [html.includes("disabled="), html.includes("aria-disabled")], [false, false]);
is("refusals are said in an alert region", html.includes('role="alert"'), true);
const full = draw(Array.from({ length: MAX_PERSON_TASKS }, (_, i) => task(i + 1)));
is("at the most a person can have, the form says so instead", [full.includes("New task"), full.includes(`This person has ${MAX_PERSON_TASKS} tasks`)], [false, true]);
is("none yet", draw([]).includes("No tasks yet."), true);

part("Undoing a removal");
const source = readFileSync("components/person-tasks.tsx", "utf8");
is("a status region, there before anything is removed, says what was removed", html.includes('<p role="status" class="text-sm text-ink [overflow-wrap:anywhere]"></p>') && source.includes("{removed ? `Removed: ${removed.text}` : \"\"}"), true);
is("only words in it: the Undo button is outside the region (round 4, L4)", /<p role="status"[^>]*>\s*\{removed \? `Removed: \$\{removed\.text\}` : ""\}\s*<\/p>/.test(source) && source.indexOf("onClick={() => void undoRemove(removed)}") > source.indexOf('<p role="status"'), true);
const gone = task(7, { text: "Send the slides", due: "2026-11-05", assignee: "sam@example.com", done: true });
is("undo puts back the words, the date and the teammate", undoBody(gone, ["owner@example.com", "sam@example.com"]), { body: { action: "add", text: "Send the slides", due: "2026-11-05", assignee: "sam@example.com" }, unassigned: false });
is("a teammate who left since: the task comes back with nobody named, and it is said, instead of not coming back", [undoBody(gone, ["owner@example.com"]), source.includes("can no longer be responsible for tasks")], [{ body: { action: "add", text: "Send the slides", due: "2026-11-05", assignee: "" }, unassigned: true }, true]);
is("the task put back is the one this add made, never one another tab added at the same moment", addedTask([task(1)], [task(1), task(9)])?.id, "task000009");
const sent = { text: "Send the slides", due: "2026-11-05", assignee: "" };
const theirs = task(8, { text: "Call Ana" });
const ours = task(9, { text: "Send the slides", due: "2026-11-05" });
is("two new at once (round 2, A-M): the one with the words, date and teammate sent, wherever it is", [addedTask([task(1)], [task(1), ours, theirs], sent)?.id, addedTask([task(1)], [task(1), theirs, ours], sent)?.id], ["task000009", "task000009"]);
is("and none only when no new one has them", [addedTask([task(1)], [task(1), theirs, task(7, { text: "Other" })], sent), addedTask([task(1)], [task(1), theirs, ours])], [null, null]);
is("said once, all of it in one message (round 2, A-L)", [undoWords(gone, true, true), undoWords({ ...gone, done: false }, false, null)], ["Task put back with nobody named, since sam@example.com can no longer be responsible for tasks. Marked done again.", "Task put back."]);
is("and when the task put back cannot be told apart, it says it is open, briefly", undoWords(gone, false, false), "Task put back. It is open: mark it done if it still is.");
is("offered only after the removal was saved", source.includes('if (await send({ action: "remove", id: task.id }, null)) {\n      setRemoved(task);'), true);
is("put back, but done again did not save (round 3, L5): it is said to be open again", undoWords(gone, false, "failed"), "Task put back. It is open again: marking it done did not save. Mark it done if it still is.");

part("The AAA audit of 4 November 2026");
is("C1: busy boxes and buttons are said to be, never switched off, and ignore a press then", !/(?<![-\w])disabled=\{/.test(source) && (source.match(/aria-disabled=\{busy \|\| undefined\}/g) ?? []).length === 3 && source.includes("aria-disabled={busy || full || undefined}") && (source.match(/if \(busy\) return;/g) ?? []).length === 3 && source.includes("if (busy || full) return;"), true);
is("C1: the focus is moved by refs once the change is drawn, never by a timer (the only timer waits for midnight, watchDay)", source.includes("}, [focusAsk]);") && !/requestAnimationFrame/.test(source) && (source.match(/setTimeout\(/g) ?? []).length === 1 && source.includes("setTimer: (run, ms) => setTimeout(run, ms)"), true);
// What each change asks for, and what it lands on, as it behaves: elements stood in for by names, "on the page" said by a set.
const onPage = new Set(["text", "due", "assignee", "undo", "full", "count", "box 1", "box 2"]);
const named = { text: "text", due: "due", assignee: "assignee", undo: "undo", full: "full", count: "count" } as const;
const boxes = new Map([["task000001", "box 1"], ["task000002", "box 2"]]);
const lands = (next: Parameters<typeof focusTarget<string>>[0], drawn: Partial<Record<keyof typeof named, string | null>> = named) => focusTarget<string>(next, { ...named, ...drawn }, boxes, (element) => onPage.has(element));
is("C1: a removal takes the focus to Undo", lands(focusAfter.removed()), "undo");
is("C1: an undo to the task put back, or to the count when it cannot be told apart", [lands(focusAfter.putBack(task(2))), lands(focusAfter.putBack(null))], ["box 2", "count"]);
is("C1: an add to the field for the next one, or to the line saying the list is full", [lands(focusAfter.added(3)), lands(focusAfter.added(MAX_PERSON_TASKS))], ["text", "full"]);
is("C1: a target not drawn (a task gone) falls to the count, never to nothing", [lands({ to: "task", id: "task000099" }), lands(focusAfter.removed(), { undo: null })], ["count", "count"]);
is("C2: a refusal of the add form to its field", lands(focusAfter.refused("due", "box 1")), "due");
is("a refusal with no field leaves the focus where it is while that is still drawn", lands(focusAfter.refused(null, "box 1")), null);
onPage.delete("box 1");
is("review of #1959 (a): the box it was on gone (another tab removed the task, read again): to the count, never to the page itself (2.4.3)", [lands(focusAfter.refused(null, "box 1")), lands(focusAfter.refused<string>(null, null))], ["count", "count"]);
is("and the count line can take it", html.includes('<p tabindex="-1" class="mt-1 text-sm text-ink-soft">2 open, 1 done.</p>') && source.includes("<p ref={fullLine} tabIndex={-1}"), true);
const told = (error: string, form = true) => { const r = refusalOf({ error, message: `Said: ${error}.` }, form); return r.quiet ? "quiet" : r.field; };
is("C2: a refusal of the add form names its field", ["text", "long", "date", "assignee", "full", "store_full", "unknown"].map((e) => told(e)), ["text", "text", "due", "assignee", null, null, null]);
is("C2: a refusal of a box or button names no field", ["text", "date", "assignee"].map((e) => told(e, false)), [null, null, null]);
is("C2: the field is marked invalid and described by the message beside it", ["text", "due", "assignee"].every((field) => source.includes(`aria-invalid={errorField === "${field}" || undefined}`)) && source.includes("`task-${field}-error`") && source.includes('send({ action: "add", text, due, assignee }, "Task added.", true)'), true);
is("the server's words are said; with none, plain ones", [refusalOf({ error: "full", message: "Full." }, false), refusalOf({ error: "data_full" }, false), refusalOf({}, false)].map((r) => (r.quiet ? "" : r.said)), ["Full.", "Your store has no room left for more records. Delete some you no longer need first.", "That did not save. Try again in a moment."]);
is("a refusal the caller answers itself is quiet; another one is not", [refusalOf({ error: "assignee" }, false, "assignee").quiet, refusalOf({ error: "unknown" }, false, "assignee").quiet], [true, false]);
is("C3: Add with nothing typed says what to do; Undo at the most a person can have says why", source.includes('if (!text.trim()) return refuse("Write what needs doing.", "text");') && source.includes('aria-describedby={full ? "task-undo-full" : undefined}') && source.includes("It cannot be put back now: this person has"), true);
is("C6: a removal and its undo are said once each", !source.includes('"Task removed."') && source.includes("task.done ? null : undoWords(task, unassigned, null)"), true);
is("a box checked off again is said in plain words", source.includes('"Marked as not done."') && !source.includes('"Open again."'), true);

part("The independent review of the audit fixes");
is("HIGH 1: a refusal with no field is said in the alert, shown", alertWords("That did not save.", null, false), { words: "That did not save.", hidden: false });
is("HIGH 1: tied to a field the focus is already in, said in the alert, hidden there as it shows beside the field", alertWords("Keep a task to 200 characters.", "text", true), { words: "Keep a task to 200 characters.", hidden: true });
is("HIGH 1: tied to a field the focus moves to, which says it, not said twice", alertWords("Pick a real date, or leave it empty.", "due", false), { words: "", hidden: true });
is("HIGH 1: whether the focus is already there is read when it is refused, the alert drawn anew each time", source.includes("=== document.activeElement);") && source.includes("<span key={errorAsk}") && source.includes("setErrorAsk((n) => n + 1);"), true);
is("MEDIUM 3: correcting the field at fault takes its refusal away", ["text", "due", "assignee"].every((field) => source.includes(`corrected("${field}");`)) && source.includes("if (errorField === field) clearError();"), true);
is("the alert region is there before any refusal, its message drawn as a new node each time", html.includes('role="alert"><span></span></p>'), true);

is("C7: a full store said in plain words", source.includes("Your store has no room left for more records. Delete some you no longer need first.") && !source.includes("data room"), true);

part("On the person's page");
const page = readFileSync("app/studio/people/page.tsx", "utf8");
is("a named section with its heading", page.includes('aria-labelledby="tasks-title"') && page.includes('<h2 id="tasks-title"'), true);
is("read with the person's page, and said when they cannot be read", page.includes("readPersonTasks(store.statsId, profile.person)") && page.includes("tasks could not be read just now"), true);
is("the teammates offered are those who can see orders", page.includes("taskAssignees(store.email, team.members)"), true);
is("the owner and the teammates who can see deals, by address in lower case", taskAssignees("Owner@Example.com", [{ email: "Sam@Example.com", role: "support" }, { email: "ed@example.com", role: "editor" }, { email: "ada@example.com", role: "admin" }]), ["owner@example.com", "sam@example.com", "ada@example.com"]);

part("A team that could not be read (review of #1959, b and c)");
is("the page sends null, never a list of the owner alone, when the team cannot be read", page.includes("const assignees = team ? taskAssignees(store.email, team.members) : null;") && page.includes("readTeam(store.sid).catch(() => null)"), true);
const unread = draw([task(1)], "2026-11-03", null);
is("only the owner offered, and said why in plain words beside the choice", [unread.includes('<option value="owner@example.com">owner@example.com</option>'), unread.includes("sam@example.com"), unread.includes(TEAM_UNREAD), unread.includes('aria-describedby="task-team-unread"')], [true, false, true, true]);
is("not said when the team was read", html.includes(TEAM_UNREAD), false);
const colleague = task(4, { text: "Call Ana", assignee: "sam@example.com" });
is("an undo of a teammate's task sends the teammate, for the server to decide, and says nothing untrue", undoBody(colleague, null), { body: { action: "add", text: "Call Ana", due: "", assignee: "sam@example.com" }, unassigned: false });
is("a refusal of the teammate has the team read again, with the tasks", [refusalOf({ error: "assignee" }, true), refusalOf({ error: "unknown" }, false)].map((r) => (r.quiet ? null : [r.stale, r.team])), [[true, true], [true, false]]);
is("read again from the route, the team with it", source.includes("&team=1") && source.includes("await reread(refusal.team)") && source.includes('if (answer.error === "assignee") await reread(true);'), true);

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
is("then the tasks are read again, so what is shown is what is kept, and the refusal says so", ["unknown", "full", "store_full", "assignee"].every((error) => { const r = refusalOf({ error }, false); return !r.quiet && r.stale; }) && source.includes("refusal.stale && (await reread(refusal.team))") && source.includes("/api/store/person-tasks?person=${encodeURIComponent(person)}") && source.includes("The list now shows the tasks as they are."), true);

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
is("except in the flags of England, Scotland and Wales, kept whole", typed(`Visit ${scotland}`), `Visit ${scotland}`);
const madeUp = "\u{1F3F4}\u{E0068}\u{E0069}\u{E0064}\u{E0065}\u{E007F}";
is("any other run of tags after a black flag goes (round 3, L1): only the flag is left", [typed(`Flag ${madeUp}`), typed(`${scotland}\u{E0068}x`)], ["Flag \u{1F3F4}", `${scotland}x`]);
is("words of tag characters only are no task", typed("\u{E0068}\u{E0069}"), "text");

// What putting a task back does, with the screen's request and its two ways of saying given here (round 4, M2).
async function undoChecks() {
  part("Putting a removed task back, step by step (round 4, M2)");
  const run = async (removed: PersonTask, answers: (PersonTask[] | string)[], assignees: string[] | null = ["owner@example.com", "sam@example.com"]) => {
    const sent: { body: Record<string, unknown>; done: string | null; quietOn?: string }[] = [];
    const said: string[] = [];
    let refusal = "";
    const result = await putBack(removed, assignees, [task(1)], {
      send: async (body, done, quietOn) => {
        sent.push({ body, done, quietOn });
        const answer = answers.shift() ?? "unknown";
        refusal = typeof answer === "string" ? answer : "";
        return typeof answer === "string" ? null : answer;
      },
      lastRefusal: () => refusal,
      toast: (words) => said.push(`toast: ${words}`),
      refuse: (words) => said.push(`refuse: ${words}`),
    });
    return { result, sent, said };
  };
  const left = task(7, { text: "Send the slides", due: "2026-11-05", assignee: "sam@example.com" });
  const back = task(9, { text: "Send the slides", due: "2026-11-05" });
  const quiet = await run(left, ["assignee", [task(1), back]]);
  is("a teammate refused by the server: the first try is quiet, the second has nobody named", [quiet.sent.map((s) => [s.body.assignee, s.quietOn ?? ""]), quiet.result.added?.id, quiet.said], [[["sam@example.com", "assignee"], ["", ""]], "task000009", []]);
  is("and the message the second try says names nobody responsible", quiet.sent[1].done, "Task put back with nobody named, since sam@example.com can no longer be responsible for tasks.");
  const doneLeft = { ...left, done: true };
  const doneFails = await run(doneLeft, [[task(1), { ...back, assignee: "sam@example.com" }], "unknown"]);
  is("put back but done again refused: said once, that it is open again", [doneFails.sent.map((s) => s.body.action), doneFails.said], [["add", "done"], ["refuse: Task put back. It is open again: marking it done did not save. Mark it done if it still is."]]);
  const doneOk = await run(doneLeft, [[task(1), { ...back, assignee: "sam@example.com" }], [task(1), { ...back, assignee: "sam@example.com", done: true }]]);
  is("put back and done again: one message, the done one's", [doneOk.sent.map((s) => s.done), doneOk.said], [[null, "Task put back. Marked done again."], []]);
  const other = await run(left, ["text"]);
  is("any other refusal is said by the request itself, with no second try", [other.sent.length, other.result.back], [1, false]);
  const unreadTeam = await run(left, [[task(1), { ...back, assignee: "sam@example.com" }]], null);
  is("the team not read: put back with the teammate, the plain words, nothing said about them leaving (review of #1959, b)", [unreadTeam.sent.map((s) => [s.body.assignee, s.done]), unreadTeam.said], [[["sam@example.com", "Task put back."]], []]);
  const refusedThen = await run(left, ["assignee", [task(1), back]], null);
  is("and when the server refuses the teammate, put back with nobody, said so then", [refusedThen.sent.map((s) => s.body.assignee), refusedThen.sent[1].done], [["sam@example.com", ""], "Task put back with nobody named, since sam@example.com can no longer be responsible for tasks."]);
  const src = readFileSync("components/person-tasks.tsx", "utf8");
  is("the request starts with no refusal left from an earlier one", src.includes('lastRefusal.current = "";\n    working.current = true;'), true);
}

void undoChecks().then(done);
