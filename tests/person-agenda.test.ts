/**
 * 639 [GL7](6), unit 3: the tasks agenda on the studio's buyers page
 * (lib/person-agenda.ts, app/studio/people/page.tsx). Who a task is about is
 * found among the store's buyers by the key the task is kept under, never
 * stored or guessed; groups in the order to act on them, cut with the rest
 * counted; each row opening the person's page by that key.
 */
import { readFileSync } from "node:fs";
import { AGENDA_SHOWN, PERSON_KEY, addressForPerson, addressesOf, agendaGroups } from "@/lib/person-agenda";
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

  part("On the buyers page");
  const page = readFileSync("app/studio/people/page.tsx", "utf8");
  is("a named section, waited for without holding the page", page.includes('<Suspense fallback={<TasksAgendaWaiting />}>') && page.includes('aria-labelledby="agenda-title"') && page.includes('aria-busy="true"'), true);
  is("each group under its own heading with its count", page.includes("<h3 className=\"text-base font-semibold text-ink\">{`${group.title} (${group.rows.length + group.more})`}</h3>"), true);
  is("a row opens the person's page by their key", page.includes("studioPath(store, `who=${row.person}`, \"people\")"), true);
  is("the page reads that key again among the buyers, and says when it is not there", page.includes("addressForPerson(store, who)") && page.includes("That person is not among the buyers read from your Stripe account just now."), true);
  is("someone not found is said to be so", page.includes("About someone not among the buyers read from your Stripe account"), true);
  is("when the tasks or Stripe cannot be read, it says so", page.includes("tasks could not be read just now. Nothing was changed.") && page.includes("Stripe could not be read just now, so who each task is about is not shown."), true);
  is("only the shown rows' people are looked up", page.includes("groups.flatMap((group) => group.rows.map((row) => row.person))"), true);

  done();
}

void main();
