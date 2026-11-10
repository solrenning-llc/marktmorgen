/**
 * The store's own task list, kept (IA2, TODOS-94, unit 2; lib/business-tasks.ts), with the in-memory Redis stand-in
 * and synthetic stores, and the "Tasks" block (components/business-tasks.tsx). Checked:
 *
 *   - added, edited, marked and removed under the store's lock, and read back whole;
 *   - counted in the store's data room before it is written, at what it weighs; a full room refuses and writes
 *     nothing; a list emptied is deleted and its room given back;
 *   - a kept list that is not read whole is unknown, never "no tasks", and a change on it writes nothing;
 *   - a write whose answer is not "OK" is unconfirmed, and keeps the larger room;
 *   - it goes with the store: the closing erases its family, and the data copy holds it;
 *   - the block: a titled section, named controls, a progress line, nothing read on the server.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessTasks } from "@/components/business-tasks";
import { BUSINESS_TASKS_SLOT, BusinessTasksUnreadable, BusinessTasksWriteUnconfirmed, changeBusinessTasks, readBusinessTasks } from "@/lib/business-tasks";
import { MAX_BUSINESS_TASKS, addBusinessTask, markBusinessTask, removeBusinessTask, editBusinessTask, type BusinessTask } from "@/lib/business-tasks-rules";
import { CLOSING, COUNTED_FAMILIES, ELSEWHERE_FAMILIES } from "@/lib/data-families";
import { type DataStore, dataKey, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0) / 1000;
const shop = (statsId: string, room: DataStore = ROOM) => ({ ...room, sid: `room-${statsId}`, statsId });
const ids = ["aaaaaaaaa1", "aaaaaaaaa2", "aaaaaaaaa3"];
const slotOf = async (store: DataStore) => {
  const [value] = await redis.pipeline([["HGET", dataKey(store)!, BUSINESS_TASKS_SLOT]]);
  return value === null ? 0 : Number(value);
};
const kept = async (statsId: string) => (await redis.pipeline([["GET", `nl:biztasks:${statsId}`]]))[0];

async function main(): Promise<void> {
  part("Kept, changed and read back whole");
  const one = shop("s1");
  is("a store that keeps none: no tasks", await readBusinessTasks("s1"), []);
  const added = await changeBusinessTasks(one, (tasks) => addBusinessTask(tasks, { title: "Record the welcome video", due: "2026-11-12" }, ids[0], NOW));
  is("added", added.ok ? added.tasks.map((t) => t.title) : added, ["Record the welcome video"]);
  await changeBusinessTasks(one, (tasks) => addBusinessTask(tasks, { title: "Send the invoice", due: "" }, ids[1], NOW));
  await changeBusinessTasks(one, (tasks) => markBusinessTask(tasks, ids[0], true, NOW + 60));
  await changeBusinessTasks(one, (tasks) => editBusinessTask(tasks, ids[1], { title: "Send the invoices", due: "2026-11-20" }));
  const read = await readBusinessTasks("s1");
  is("read back whole", read.map((t) => [t.title, t.due, t.done]), [["Record the welcome video", "2026-11-12", true], ["Send the invoices", "2026-11-20", false]]);
  is("a refusal writes nothing", await changeBusinessTasks(one, (tasks) => removeBusinessTask(tasks, "zzzzzzzzzz")), { ok: false, error: "unknown" });

  part("Counted in the data room before it is written");
  const raw = await kept("s1");
  is("the slot holds what the list weighs", await slotOf(one), dataBytes(["nl:biztasks:s1", String(raw)], 1));
  const tiny = shop("s2", { ...ROOM, tier: undefined, subscriptionActive: false, subscriptionId: "", trialEnds: 0, planEndedAt: "" });
  await needData(tiny, [{ slot: "fill", bytes: 5_000_000 - 64, set: true }]);
  const full = await changeBusinessTasks(tiny, (tasks) => addBusinessTask(tasks, { title: "One more", due: "" }, ids[0], NOW));
  is("a full room: said, with its words", full.ok === false && full.error === "store_full" && typeof (full as { message?: string }).message === "string", true);
  is("and nothing written", await kept("s2"), null);
  await changeBusinessTasks(one, (tasks) => editBusinessTask(tasks, ids[1], { title: "Invoices", due: "" }));
  is("a list that got lighter: its room comes down to what it weighs now", await slotOf(one), dataBytes(["nl:biztasks:s1", String(await kept("s1"))], 1));
  await changeBusinessTasks(one, (tasks) => removeBusinessTask(tasks, ids[0]));
  const emptied = await changeBusinessTasks(one, (tasks) => removeBusinessTask(tasks, ids[1]));
  is("the last one removed", emptied, { ok: true, tasks: [] });
  is("an empty list is deleted", await kept("s1"), null);
  is("and its room given back", await slotOf(one), 0);

  part("At most MAX_BUSINESS_TASKS");
  const many = shop("s3");
  const list: BusinessTask[] = Array.from({ length: MAX_BUSINESS_TASKS }, (_, n) => ({ id: `m${String(n).padStart(9, "0")}`, title: `Task ${n}`, due: "", done: false, createdAt: NOW, doneAt: 0 }));
  await redis.pipeline([["SET", "nl:biztasks:s3", JSON.stringify(list)]]);
  is("one more past the most is refused, nothing written", [await changeBusinessTasks(many, (tasks) => addBusinessTask(tasks, { title: "x", due: "" }, ids[2], NOW)), JSON.parse(String(await kept("s3"))).length], [{ ok: false, error: "full" }, MAX_BUSINESS_TASKS]);

  part("Unknown, never no tasks");
  const bent = shop("s4");
  await redis.pipeline([["SET", "nl:biztasks:s4", JSON.stringify([{ id: ids[0], title: "Fine", due: "", done: false, createdAt: NOW, doneAt: 0 }, { id: "BAD", title: "x" }])]]);
  let thrown: unknown = null;
  try {
    await readBusinessTasks("s4");
  } catch (error) {
    thrown = error;
  }
  is("a list with one bent task: unknown, never the rest", thrown instanceof BusinessTasksUnreadable, true);
  thrown = null;
  try {
    await changeBusinessTasks(bent, (tasks) => addBusinessTask(tasks, { title: "New", due: "" }, ids[1], NOW));
  } catch (error) {
    thrown = error;
  }
  is("a change on it throws and writes nothing", [thrown instanceof BusinessTasksUnreadable, String(await kept("s4")).includes("New")], [true, false]);
  await redis.pipeline([["SET", "nl:biztasks:s4", "{not json"]]);
  thrown = null;
  try {
    await readBusinessTasks("s4");
  } catch (error) {
    thrown = error;
  }
  is("not JSON: unknown", thrown instanceof BusinessTasksUnreadable, true);
  {
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "GET" ? [] : real(commands))) as typeof redis.pipeline;
    thrown = null;
    try {
      await readBusinessTasks("s1");
    } catch (error) {
      thrown = error;
    }
    is("a reply missing: unknown", thrown instanceof BusinessTasksUnreadable, true);
    redis.pipeline = real as typeof redis.pipeline;
  }

  part("A write whose answer is not OK is unconfirmed");
  {
    const lost = shop("s5");
    await changeBusinessTasks(lost, (tasks) => addBusinessTask(tasks, { title: "Short", due: "" }, ids[0], NOW));
    const before = await slotOf(lost);
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:biztasks:") ? [null] : real(commands))) as typeof redis.pipeline;
    thrown = null;
    try {
      await changeBusinessTasks(lost, (tasks) => addBusinessTask(tasks, { title: "A much longer task than the first one", due: "" }, ids[1], NOW));
    } catch (error) {
      thrown = error;
    }
    redis.pipeline = real as typeof redis.pipeline;
    is("said as unconfirmed", thrown instanceof BusinessTasksWriteUnconfirmed, true);
    is("the room kept at the larger list's, never given back on a guess", (await slotOf(lost)) > before, true);
  }

  part("It goes with the store");
  is("counted in the room", COUNTED_FAMILIES.includes("nl:biztasks:"), true);
  is("erased in the closing", CLOSING["nl:biztasks:"], { how: "erase" });
  is("its lock expires by itself", [ELSEWHERE_FAMILIES.includes("nl:biztasklock:"), CLOSING["nl:biztasklock:"]], [true, { how: "expires", days: 1 }]);
  const exported = readFileSync("lib/store-export.ts", "utf8");
  is("the data copy holds it, read whole, never as none", /,"tasks":\$\{JSON\.stringify\(businessTaskCopy\(await readBusinessTasks\(statsId\)\)\)\}/.test(exported), true);

  part("The block");
  const html = renderToStaticMarkup(createElement(BusinessTasks));
  is("a section named by its heading", /<section aria-labelledby="([^"]+)-title"[^>]*><h2 id="\1-title"[^>]*>Tasks<\/h2>/.test(html), true);
  is("it says it is loading, never no tasks, before it read", html.includes("Loading your tasks") && !html.includes("No tasks yet"), true);
  is("a polite live region for what happened", /role="status" aria-live="polite"/.test(html), true);
  const route = readFileSync("app/api/store/business-tasks/route.ts", "utf8");
  is("the route needs settings both ways", /jsonAccess\(request, "settings"\)/.test(route) && /guardStoreWrite\(request, "settings"/.test(route), true);
  is("an unreadable list is 503 in plain words", /status: 503/.test(route) && /BUSINESS_TASKS_NOT_READ/.test(route), true);
  const page = readFileSync("app/studio/page.tsx", "utf8");
  is("on the studio's home for whoever runs the settings", /\{may\("settings"\) \? <BusinessTasks \/> : null\}/.test(page), true);
  done();
}

void main();
