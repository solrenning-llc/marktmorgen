/**
 * 656 [WG16], unit 9: the empty lists on a person's page (notes, tasks) use
 * the studio's shared empty state, with an action that jumps to the form
 * the person can use, and the bare old lines are gone.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const notes = readFileSync("components/person-notes.tsx", "utf8");
const tasks = readFileSync("components/person-tasks.tsx", "utf8");

part("Notes");
is("imports the studio empty state", notes.includes('import { StudioEmptyState } from "@/components/empty-state";'), true);
is(
  "draws it with a jump to the note box",
  notes.includes('<StudioEmptyState title="No notes yet" body="A note you save here keeps what you know about this person, for you and your team." action={{ href: "#person-note", label: "Add the first note" }} className="mt-4" />'),
  true,
);
is("the jump target exists", /<textarea[^>]*\bid="person-note"/.test(notes), true);
is("the bare line is gone", notes.includes('<p className="mt-2 text-sm text-ink-soft">No notes yet.</p>'), false);

part("Tasks");
is("imports the studio empty state", tasks.includes('import { StudioEmptyState } from "@/components/empty-state";'), true);
is(
  "draws it with a jump to the task box",
  tasks.includes('<StudioEmptyState title="No tasks for this person yet" body="A task you add here lists what you still owe this person, and shows in your team\'s tasks to do." action={{ href: "#task-text", label: "Add the first task" }} className="mt-4" />'),
  true,
);
is("the jump target exists", /id="task-text"/.test(tasks), true);
is("the count sentence stays for a list with tasks", tasks.includes("`${open} open, ${tasks.length - open} done.`"), true);
is("the count line stays the focus anchor in both cases", tasks.includes("<p ref={countLine} tabIndex={-1}"), true);
is("an empty list keeps its status text for screen readers only, never as the visible bare line", tasks.includes('className={tasks.length ? "mt-1 text-sm text-ink-soft" : "sr-only focus:not-sr-only mt-1 text-sm text-ink-soft"}'), true);
done();
