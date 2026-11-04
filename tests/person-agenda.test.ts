/**
 * 639 [GL7](6), unit 3: the tasks agenda on the studio's buyers page
 * (lib/person-agenda.ts, app/studio/people/page.tsx). Who a task is about is
 * found among the store's buyers by the key the task is kept under, never
 * stored or guessed; groups in the order to act on them, cut with the rest
 * counted; each row opening the person's page by that key.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type AgendaListRow, TasksAgendaList, agendaDay, agendaLinkWords } from "@/components/tasks-agenda";
import { AGENDA_SHOWN, PERSON_KEY, addressForPerson, addressesOf, agendaForDays, agendaGroups, daysAround } from "@/lib/person-agenda";
import { personKey } from "@/lib/person-key";
import type { DueTask, PersonTask } from "@/lib/person-tasks";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

async function main() {
  const STATS = "s".repeat(16);
  const ann = personKey(STATS, "ann@example.com");
  const bob = personKey(STATS, "bob@example.com");
  const ghost = personKey(STATS, "ghost@example.com");
  const task = (n: number, over: Partial<PersonTask> = {}): PersonTask => ({ id: `task${String(n).padStart(6, "0")}`, text: `Task ${n}`, due: "", assignee: "", done: false, createdAt: n, doneAt: 0, ...over });
  const due = (person: string, n: number, over: Partial<PersonTask> = {}): DueTask => ({ person, task: task(n, over) });

  part("Who a task is about");
  const found = addressesOf(STATS, new Set([ann, ghost]), ["bob@example.com", "Ann@Example.com", "ann@example.com"]);
  is("found by the key the task is kept under, the first address that has it", [found.get(ann), found.size], ["Ann@Example.com", 1]);
  is("someone not among the buyers is not guessed", found.has(ghost), false);
  is("nobody wanted, nothing read", addressesOf(STATS, new Set(), ["ann@example.com"]).size, 0);
  is("a person's key is the 32 characters the tasks use", [PERSON_KEY.test(ann), PERSON_KEY.test("ann@example.com")], [true, false]);
  is("a page asked for by a bad key reads nothing", await addressForPerson({ statsId: STATS } as Store, "../ann"), null);

  part("The groups");
  const groups = agendaGroups({ overdue: [due(ann, 1, { due: "2026-11-01" })], today: [], upcoming: [due(bob, 2, { due: "2026-11-09" })], undated: [due(ghost, 3)] }, new Map([[ann, "ann@example.com"]]));
  is("in the order to act on them, an empty group left out", groups.map((group) => group.title), ["Past their date", "Coming up", "No date"]);
  is("each row with its address, or none when not found", groups.map((group) => group.rows[0].email), ["ann@example.com", null, null]);
  const many = agendaGroups({ overdue: [], today: Array.from({ length: AGENDA_SHOWN + 7 }, (_, i) => due(ann, i + 1, { due: "2026-11-03" })), upcoming: [], undated: [] }, new Map());
  is("a long group cut, the rest counted", [many[0].rows.length, many[0].more], [AGENDA_SHOWN, 7]);
  is("nothing open, no groups", agendaGroups({ overdue: [], today: [], upcoming: [], undated: [] }, new Map()).length, 0);

  part("The creator's own day, not the server's");
  // 01:30 UTC on 4 November: the server's day is the 4th, and in Fortaleza (UTC-3) it is 22:30 on the 3rd.
  is("the days the creator's may be: the one before, the server's and the one after", [daysAround("2026-11-04"), daysAround("2026-12-31"), daysAround("2026-03-01")], [
    ["2026-11-03", "2026-11-04", "2026-11-05"],
    ["2026-12-30", "2026-12-31", "2027-01-01"],
    ["2026-02-28", "2026-03-01", "2026-03-02"],
  ]);
  const entries = [due(ann, 1, { due: "2026-11-03" }), due(bob, 2, { due: "2026-11-04" }), due(ann, 3, { due: "2026-11-02" }), due(bob, 4, { done: true, due: "2026-11-01" })];
  const agenda = agendaForDays(entries, daysAround("2026-11-04"));
  const titles = (day: string) => Object.fromEntries(agenda.days[day].map((group) => [group.title, group.rows.map((place) => agenda.rows[place].task.text)]));
  is("on the 3rd in Fortaleza, the task due the 3rd is due today and the 4th's is to come", titles("2026-11-03"), { "Past their date": ["Task 3"], "Due today": ["Task 1"], "Coming up": ["Task 2"] });
  is("on the 4th in UTC, the 3rd's is past", titles("2026-11-04"), { "Past their date": ["Task 3", "Task 1"], "Due today": ["Task 2"] });
  is("each open task sent once, a done one never", agenda.rows.map((row) => row.task.text).sort(), ["Task 1", "Task 2", "Task 3"]);
  const rows: AgendaListRow[] = agenda.rows.map((row) => ({ ...row, email: row.person === ann ? "ann@example.com" : null, href: row.person === ann ? `/studio/people?who=${ann}` : "" }));
  const drawn = (serverDay: string) => renderToStaticMarkup(createElement(TasksAgendaList, { rows, days: agenda.days, serverDay, found: { partial: false } }));
  const fortaleza = drawn("2026-11-03");
  is("drawn for the 3rd: due today, not past", [fortaleza.includes("Due today (1)"), fortaleza.includes("Due Nov 3, 2026"), fortaleza.includes("Was due Nov 3, 2026")], [true, true, false]);
  is("and the 2nd's past, the 4th's to come", [fortaleza.includes("Was due Nov 2, 2026"), fortaleza.includes("Due Nov 4, 2026")], [true, true]);
  is("drawn for the 4th, the 3rd's is past", drawn("2026-11-04").includes("Was due Nov 3, 2026"), true);
  is("a row opens the person's page, or says they were not found", [fortaleza.includes(`href="/studio/people?who=${ann}"`), fortaleza.includes("About someone not among the buyers read from your Stripe account: find them")], [true, true]);
  const list = readFileSync("components/tasks-agenda.tsx", "utf8");
  is("the browser's day takes over after the server's drawing", list.includes("const creatorDay = useCreatorDay(serverDay);") && list.includes("const { today, stale } = agendaDay(days, creatorDay, serverDay);"), true);

  part("A page left open, and its links (edge review)");
  is("a day the server made the groups for is drawn as it is", agendaDay(agenda.days, "2026-11-05", "2026-11-04"), { today: "2026-11-05", stale: false });
  is("two midnights later the groups are out of date, and it is said, never guessed", [agendaDay(agenda.days, "2026-11-06", "2026-11-04"), agendaDay(agenda.days, "__proto__", "2026-11-04").stale], [{ today: "2026-11-04", stale: true }, true]);
  is("the creator is offered to read them again, never moved by the page on its own", list.includes("A new day has started since this page was opened") && list.includes("onClick={() => window.location.reload()}") && !list.includes("router.refresh()"), true);
  is("the person's day moves on at midnight on its own (components/person-tasks.tsx, watchDay)", readFileSync("components/person-tasks.tsx", "utf8").includes("useSyncExternalStore(watchBrowserDay,"), true);
  is("a link's own words say where it goes, not an address alone", [agendaLinkWords("ann@example.com"), fortaleza.includes(">Open the buyer page of ann@example.com</a>")], ["Open the buyer page of ann@example.com", true]);

  part("The deals page's day (edge review)");
  const board = readFileSync("components/deals-board.tsx", "utf8");
  is("deals are compared with the creator's own day, as the tasks are, not the server's UTC one", board.includes("const today = useCreatorDay(serverDay);") && board.includes("today: serverDay, initialFilter") && !board.includes("(UTC). Won and lost"), true);
  is("and the page says whose day it is", board.includes("Dates use your own calendar day, {today}, where this browser is."), true);

  part("On the buyers page");
  const page = readFileSync("app/studio/people/page.tsx", "utf8");
  is("a named section, waited for without holding the page", page.includes('<Suspense fallback={<TasksAgendaWaiting />}>') && page.includes('aria-labelledby="agenda-title"') && page.includes('aria-busy="true"'), true);
  is("each group under its own heading with its count", list.includes("<h3 className=\"text-base font-semibold text-ink\">{`${group.title} (${group.rows.length + group.more})`}</h3>"), true);
  is("a row opens the person's page by their key", page.includes("studioPath(store, `who=${row.person}`, \"people\")"), true);
  is("the page reads that key again among the buyers, and says when it is not there", page.includes("addressForPerson(store, who)") && page.includes("That person is not among the buyers read from your Stripe account just now."), true);
  is("someone not found is said to be so", list.includes("About someone not among the buyers read from your Stripe account"), true);
  is("when the tasks or Stripe cannot be read, it says so", page.includes("tasks could not be read just now. Nothing was changed.") && page.includes("Stripe could not be read just now, so who each task is about is not shown."), true);
  is("only the shown rows' people are looked up, on any of the days", page.includes("const persons = new Set(agenda.rows.map((row) => row.person));"), true);
  is("the groups made for each day the creator's may be", page.includes("agendaForDays(all, daysAround(today))") && page.includes("<TasksAgendaList rows={rows} days={agenda.days} serverDay={today}"), true);

  done();
}

void main();
