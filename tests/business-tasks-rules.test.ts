/**
 * The store's own task list (IA2, TODOS-94, unit 1; lib/business-tasks-rules.ts). Pure; synthetic tasks. Checked:
 *
 *   - a task has a title, an optional real calendar date, and is done or not;
 *   - an empty, unseen or too long title, or a date that is not a real one, is refused, never cut or guessed;
 *   - at most MAX_BUSINESS_TASKS a store, open and done together, refused whole past it;
 *   - a list not read whole is unknown (null), never "no tasks" and never the part that read;
 *   - edit, mark and remove say when the task is no longer there;
 *   - the order shown, where each task stands against today, the progress line and the data copy's rows.
 */
import {
  BUSINESS_TASK_REFUSALS,
  MAX_BUSINESS_TASKS,
  MAX_BUSINESS_TASK_TITLE,
  addBusinessTask,
  businessDueState,
  businessProgress,
  businessTaskCopy,
  businessTaskOrder,
  editBusinessTask,
  markBusinessTask,
  parseBusinessTasks,
  readBusinessTaskInput,
  removeBusinessTask,
  type BusinessTask,
} from "@/lib/business-tasks-rules";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0) / 1000;
const task = (id: string, over: Partial<BusinessTask> = {}): BusinessTask => ({ id, title: `Task ${id}`, due: "", done: false, createdAt: NOW, doneAt: 0, ...over });
const id = (n: number) => `t${String(n).padStart(9, "0")}`;

part("What a task is");
is("a title and no date", readBusinessTaskInput({ title: "  Record the   welcome video " }), { ok: true, value: { title: "Record the welcome video", due: "" } });
is("a title and a date", readBusinessTaskInput({ title: "Send the invoice", due: "2026-11-12" }), { ok: true, value: { title: "Send the invoice", due: "2026-11-12" } });
is("no title", readBusinessTaskInput({ title: "   " }), { ok: false, error: "title" });
is("only unseen signs", readBusinessTaskInput({ title: "​​" }), { ok: false, error: "title" });
is("not text", readBusinessTaskInput({ title: 12 }), { ok: false, error: "title" });
is("too long: refused, never cut", readBusinessTaskInput({ title: "a".repeat(MAX_BUSINESS_TASK_TITLE + 1) }), { ok: false, error: "long" });
is("the longest allowed", readBusinessTaskInput({ title: "a".repeat(MAX_BUSINESS_TASK_TITLE) }).ok, true);
is("a date that does not exist", readBusinessTaskInput({ title: "x", due: "2026-02-30" }), { ok: false, error: "date" });
is("a date in another shape", readBusinessTaskInput({ title: "x", due: "11/12/2026" }), { ok: false, error: "date" });
is("the refusals say what to do", BUSINESS_TASK_REFUSALS.full, `Your store keeps up to ${MAX_BUSINESS_TASKS} tasks. Remove a done one first.`);

part("At most MAX_BUSINESS_TASKS a store");
{
  const full = Array.from({ length: MAX_BUSINESS_TASKS }, (_, n) => task(id(n), { done: n % 2 === 0, doneAt: n % 2 === 0 ? NOW : 0 }));
  is("one more past the most: refused whole", addBusinessTask(full, { title: "One more", due: "" }, id(999), NOW), { ok: false, error: "full" });
  is("done tasks count too", addBusinessTask(full.map((t) => ({ ...t, done: true, doneAt: NOW })), { title: "One more", due: "" }, id(999), NOW), { ok: false, error: "full" });
  const room = full.slice(1);
  const added = addBusinessTask(room, { title: "One more", due: "2026-11-11" }, id(999), NOW);
  is("one under the most: added, open, written now", added.ok ? added.tasks[added.tasks.length - 1] : null, { id: id(999), title: "One more", due: "2026-11-11", done: false, createdAt: NOW, doneAt: 0 });
  is("an id taken: refused", addBusinessTask([task(id(1))], { title: "x", due: "" }, id(1), NOW), { ok: false, error: "unknown" });
  is("an id not in shape: refused", addBusinessTask([], { title: "x", due: "" }, "BAD", NOW), { ok: false, error: "unknown" });
}

part("A list not read whole is unknown");
{
  const good = [task(id(1)), task(id(2), { done: true, doneAt: NOW + 5, due: "2026-11-01" })];
  is("a list in its shape reads whole", parseBusinessTasks(JSON.parse(JSON.stringify(good))), good);
  is("an empty list is no tasks", parseBusinessTasks([]), []);
  is("not a list", parseBusinessTasks({}), null);
  is("more than the most", parseBusinessTasks(Array.from({ length: MAX_BUSINESS_TASKS + 1 }, (_, n) => task(id(n)))), null);
  const bent: [string, unknown][] = [
    ["one entry not an object", [good[0], "x"]],
    ["an id twice", [good[0], good[0]]],
    ["an id out of shape", [{ ...good[0], id: "X" }]],
    ["a title too long", [{ ...good[0], title: "a".repeat(MAX_BUSINESS_TASK_TITLE + 1) }]],
    ["a title not kept as one line", [{ ...good[0], title: "two\nlines" }]],
    ["a date not real", [{ ...good[0], due: "2026-13-01" }]],
    ["done not a yes or no", [{ ...good[0], done: "yes" }]],
    ["a time not whole", [{ ...good[0], createdAt: 1.5 }]],
    ["open with a done time", [{ ...good[0], doneAt: NOW }]],
  ];
  for (const [what, raw] of bent) is(`${what}: the whole list unknown, never the rest`, parseBusinessTasks(raw), null);
  is("an older task without its times reads with 0", parseBusinessTasks([{ id: id(3), title: "Old", due: "", done: false }]), [{ id: id(3), title: "Old", due: "", done: false, createdAt: 0, doneAt: 0 }]);
}

part("Edit, mark and remove");
{
  const list = [task(id(1)), task(id(2))];
  const edited = editBusinessTask(list, id(2), { title: "New words", due: "2026-12-01" });
  is("edited in place, done unchanged", edited.ok ? edited.tasks[1] : null, { ...list[1], title: "New words", due: "2026-12-01" });
  const marked = markBusinessTask(list, id(1), true, NOW + 60);
  is("marked done now", marked.ok ? [marked.tasks[0].done, marked.tasks[0].doneAt] : null, [true, NOW + 60]);
  const reopened = marked.ok ? markBusinessTask(marked.tasks, id(1), false, NOW + 120) : null;
  is("open again: its done time goes", reopened && reopened.ok ? [reopened.tasks[0].done, reopened.tasks[0].doneAt] : null, [false, 0]);
  is("removed", removeBusinessTask(list, id(1)), { ok: true, tasks: [list[1]] });
  for (const [what, result] of [
    ["edit", editBusinessTask(list, id(9), { title: "x", due: "" })],
    ["mark", markBusinessTask(list, id(9), true, NOW)],
    ["remove", removeBusinessTask(list, id(9))],
  ] as const)
    is(`${what} a task no longer there: said so`, result, { ok: false, error: "unknown" });
}

part("Order, today and progress");
{
  const list = [
    task(id(1), { title: "Undated old", createdAt: NOW - 100 }),
    task(id(2), { title: "Due later", due: "2026-11-20" }),
    task(id(3), { title: "Done first", done: true, doneAt: NOW - 50 }),
    task(id(4), { title: "Due sooner", due: "2026-11-09" }),
    task(id(5), { title: "Undated new", createdAt: NOW }),
    task(id(6), { title: "Done last", done: true, doneAt: NOW }),
  ];
  is("open by date, undated after, then done latest first", businessTaskOrder(list).map((t) => t.title), ["Due sooner", "Due later", "Undated old", "Undated new", "Done last", "Done first"]);
  is("the order does not change the list", list[0].title, "Undated old");
  const today = "2026-11-10";
  is("where each stands", [list[3], task(id(7), { due: today }), list[1], list[0], list[2]].map((t) => businessDueState(t, today)), ["overdue", "today", "upcoming", "none", "done"]);
  is("a today that is not a date never says overdue", businessDueState(list[3], "tomorrow"), "upcoming");
  is("progress", businessProgress(list), { done: 2, total: 6, words: "2 of 6 done." });
  is("no tasks", businessProgress([]), { done: 0, total: 0, words: "No tasks yet." });
  is("a list not known has no progress, never 0 of 0", businessProgress(null), null);
}

part("The data copy");
{
  const rows = businessTaskCopy([task(id(1), { title: "Open one", due: "2026-11-12", createdAt: NOW }), task(id(2), { title: "Done one", done: true, createdAt: 0, doneAt: NOW })]);
  is("one row a task, in the list's order, times in UTC, blank when not known", rows, [
    { title: "Open one", due: "2026-11-12", done: false, created_utc: "2026-11-10T12:00:00.000Z", done_utc: "" },
    { title: "Done one", due: "", done: true, created_utc: "", done_utc: "2026-11-10T12:00:00.000Z" },
  ]);
}

done();
