/**
 * C3-123 (c), on C3-125's model: a task or a note about a person who was
 * deleted from the store is never written while they are deleted, whatever
 * the request says, and never from a page read (or a workflow step started)
 * before the deletion, even once they came back. Only the server takes the
 * deletion's mark away, when they come back on their own (a paid order, a
 * confirmed sign-up, a free product, a form: lib/crm.ts personReturned); a
 * page read since then writes as for anyone. Through the real routes
 * (app/api/store/person-tasks, app/api/store/person) and a workflow's note
 * step, on the in-memory Redis, with what each save sends held under the one
 * studio request it takes.
 */
import { NextRequest } from "next/server";
import { POST as tasksPost } from "@/app/api/store/person-tasks/route";
import { POST as personPost } from "@/app/api/store/person/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { WRITE_TASKS_CALLS, erasedKey, forgetCrmPerson, readGeneration, readPersonTasks } from "@/lib/crm";
import { ADD_NOTE_CALLS, ADD_PERSON_NOTE, forgetNotesPerson, readPersonNotes } from "@/lib/buyer-profile";
import { ERASERS } from "@/lib/person-erasure";
import { listOrder } from "@/lib/buyer-list";
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { personKey } from "@/lib/person-key";
import { dataUsed } from "@/lib/store-data";
import { utf8Length } from "@/lib/store-data-rules";
import { PIN_HEADER } from "@/lib/studio-route";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM, roomOnly } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Reply = { ok?: boolean; error?: string; message?: string; tasks?: unknown[]; notes?: { text: string }[] };

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_erased_writes";
  process.env.RESEND_API_KEY = "re_test_erased_writes";
  const OWNER = "erased-writes@example.com";
  await claimHandle(OWNER, "erasedwrites", "Erased Writes", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestErasedW001", true);
  await setSubscription(OWNER, { customerId: "cus_ErasedW0001", subscriptionId: "sub_ErasedW0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Erased Writes", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const ANA = personKey(statsId, "ana@example.com");
  const mark = erasedKey(statsId, ANA);
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  // As the studio sends it: every request names its store (components/studio-store-pin.tsx).
  const send = async (route: typeof tasksPost, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", headers: { "content-type": "application/json", cookie, [PIN_HEADER]: store.sid }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const task = (body: Record<string, unknown>) => send(tasksPost, "/api/store/person-tasks", { person: ANA, ...body });
  const note = (body: Record<string, unknown>) => send(personPost, "/api/store/person", { action: "note", person: ANA, ...body });
  const used = async () => (await dataUsed(store))?.used ?? 0;
  const marked = async () => (await redis.pipeline([["EXISTS", mark]]))[0];
  // The deletion's own CRM parts, in the order lib/person-erasure.ts runs them: the CRM (which leaves the mark) before the notes.
  const erase = async () => {
    await forgetCrmPerson(statsId, ANA, "ana@example.com", store);
    await forgetNotesPerson(statsId, ANA);
  };
  let orders = 0;
  // A real return: a paid order (lib/buyer-list.ts, listOrder).
  const buys = async () => {
    store = (await storeForEmail(OWNER))!;
    orders += 1;
    return listOrder(store, { sessionId: `cs_test_erasedwrites${String(orders).padStart(3, "0")}`, email: "ana@example.com", news: false, created: Math.floor(Date.now() / 1000) + 1, products: [{ id: "prod01", title: "Course" }] });
  };

  part("The deletion leaves its mark before the notes are taken away");
  const order = ERASERS.map((e) => e.module);
  is("the CRM's part runs before the notes'", order.indexOf("lib/crm.ts") >= 0 && order.indexOf("lib/crm.ts") < order.indexOf("lib/buyer-profile.ts"), true);

  part("Before: a task and a note written from a page read now");
  const read = await readGeneration(statsId, ANA);
  is("(never deleted: generation 0)", read, 0);
  is("a task", (await task({ action: "add", text: "Send the workbook", generation: read })).status, 200);
  is("a note", (await note({ text: "Asked about the course.", generation: read })).status, 200);
  is("a page drawn before generations were sent: read as 0, and written", (await note({ text: "From an old page." })).status, 200);
  is("both kept", [(await readPersonTasks(statsId, ANA)).length, (await readPersonNotes(statsId, ANA)).length], [1, 2]);
  await erase();
  const empty = await used();
  is("the deletion took them", [(await readPersonTasks(statsId, ANA)).length, (await readPersonNotes(statsId, ANA)).length], [0, 0]);

  part("While they are deleted, no task or note is written, whatever the request carries (C3-125)");
  // However long ago (the mark's time put back a day), with the page's generation, the one now, one made up, or none.
  await redis.pipeline([["SET", mark, String(Date.now() - 86_400_000), "EX", 3600]]);
  const now = await readGeneration(statsId, ANA);
  is("their generation is one more", now, 1);
  for (const carried of [read, now, 99, undefined]) {
    const generation = carried === undefined ? {} : { generation: carried };
    const lateTask = await task({ action: "add", text: "Call back", preparedAt: Date.now(), ...generation });
    is(`a task carrying ${String(carried)}: 404 gone, with what to do`, [lateTask.status, lateTask.body.error, lateTask.body.message], [404, "gone", "This person is no longer in your store, so nothing was saved. Reload the page."]);
    const lateNote = await note({ text: "Called back.", preparedAt: Date.now(), ...generation });
    is(`a note carrying ${String(carried)}: 404 unknown`, [lateNote.status, lateNote.body.error], [404, "unknown"]);
  }
  is("nothing about them is kept", [await readPersonTasks(statsId, ANA), await readPersonNotes(statsId, ANA)], [[], []]);
  is("the room taken for them is given back", await used(), empty);
  is("the mark stays", await marked(), 1);

  part("A note whose room was taken, with the deletion in between, then written: refused");
  is("(she buys: the mark goes)", [await buys(), await marked()], ["done", 0]);
  const before = await readGeneration(statsId, ANA);
  const original = redis.pipeline;
  let armed = true;
  redis.pipeline = async (commands) => {
    if (armed && roomOnly(commands)) {
      armed = false;
      await erase();
    }
    return original.call(redis, commands);
  };
  const raced = await note({ text: "Typed before the deletion.", generation: before });
  redis.pipeline = original;
  is("the deletion ran in between, and the note is refused", [armed, raced.status], [false, 404]);
  is("not written", await readPersonNotes(statsId, ANA), []);

  part("A task change that started before the deletion and wrote after it: refused");
  is("(she buys again)", [await buys(), await marked()], ["done", 0]);
  const taskRead = await readGeneration(statsId, ANA);
  armed = true;
  let erasing: Promise<void> | null = null;
  redis.pipeline = async (commands) => {
    if (armed && roomOnly(commands)) {
      armed = false;
      // The deletion leaves its mark, then waits for the tasks' lock this change holds.
      erasing = erase();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return original.call(redis, commands);
  };
  const racedTask = await task({ action: "add", text: "Typed before the deletion", generation: taskRead });
  redis.pipeline = original;
  await erasing;
  is("refused: gone", [armed, racedTask.status, racedTask.body.error], [false, 404, "gone"]);
  is("not written", await readPersonTasks(statsId, ANA), []);
  is("and no room counted for it", await used(), empty);

  part("A real return, by a paid order: the mark goes; a page read since writes, one read before never does");
  is("(she buys)", [await buys(), await marked()], ["done", 0]);
  is("a page read before the deletion: the task still 404 gone", (await task({ action: "add", text: "Stale", generation: taskRead })).body.error, "gone");
  is("and the note still 404", (await note({ text: "Stale.", generation: taskRead })).status, 404);
  const since = await readGeneration(statsId, ANA);
  const backTask = await task({ action: "add", text: "Welcome back", generation: since });
  is("a page read since: the task is written", [backTask.status, (await readPersonTasks(statsId, ANA)).map((t) => t.text)], [200, ["Welcome back"]]);
  const backNote = await note({ text: "Bought again.", generation: since });
  is("and the note", [backNote.status, (await readPersonNotes(statsId, ANA)).map((n) => n.text)], [200, ["Bought again."]]);

  part("What a task or a note sends, within the one studio request each save takes");
  const measure = async (run: () => Promise<{ status: number }>) => {
    let trips = 0;
    let commands = 0;
    let inside = 0;
    let bytes = 0;
    const size = (v: unknown): number => (typeof v === "string" ? utf8Length(v) : typeof v === "number" ? String(v).length : Array.isArray(v) ? v.reduce((n: number, x) => n + size(x), 0) : v && typeof v === "object" ? size(Object.values(v)) : 0);
    redis.pipeline = async (sent) => {
      trips += 1;
      commands += sent.length;
      // Inside the scripts that write about a person: the mark and the generation read, then the writes.
      for (const c of sent) {
        if (c[0] !== "EVAL") continue;
        if (c[1] === ADD_PERSON_NOTE) inside += ADD_NOTE_CALLS;
        else if (String(c[1]).startsWith("-- marktmorgen:crm-tasks-write:")) inside += WRITE_TASKS_CALLS;
      }
      const replies = await original.call(redis, sent);
      bytes += size(sent) + size(replies);
      return replies;
    };
    try { return { status: (await run()).status, trips, commands, inside, bytes }; } finally { redis.pipeline = original; }
  };
  // Trips one after another, as the in-memory Redis answers them (the lock's own scripts run there as separate commands,
  // two more trips than on Upstash): no more than before this change, which took the lock's hold out of a task's write
  // (17 in the stand-in) and the read-back into a note's script (8). Commands and bytes within one studio request's.
  for (const [what, run, most] of [["a task", () => task({ action: "add", text: "x".repeat(200), generation: since }), 14], ["a note", () => note({ text: "x".repeat(1_000), generation: since }), 7]] as const) {
    const m = await measure(run);
    is(`${what}: saved, ${m.trips} trips (no more than ${most}), ${m.commands} commands sent and ${m.inside} inside its script, ${m.bytes} bytes: within twenty and the count's, and 50,000`, [m.status, m.trips <= most, m.commands + m.inside <= 24, m.bytes <= 50_000], [200, true, true, true]);
  }


  part("A workflow's note step started before the deletion writes nothing about them after it");
  await erase();
  is("(she buys again)", [await buys(), await marked()], ["done", 0]);
  await writeForm(statsId, parseForm({ id: "applyform1", name: "Apply", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] })!);
  const saved = await saveFlow(store, { name: "Applicants", trigger: "form", formId: "applyform1", active: true, steps: [{ delayHours: 0, action: { do: "note", text: "Applied" } }] } as never, { activate: true });
  is("(a workflow with a note step)", saved.ok, true);
  await upsertContact(store.listId!, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "ana@example.com", { joined: false, form: "applyform1" });
  armed = true;
  redis.pipeline = async (commands) => {
    // The step has read their generation; its note's room is being taken when the deletion runs.
    if (armed && roomOnly(commands)) {
      armed = false;
      await erase();
    }
    return original.call(redis, commands);
  };
  await sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
  redis.pipeline = original;
  is("the deletion ran during the step", armed, false);
  is("no note about them", await readPersonNotes(statsId, ANA), []);

  part("Started after they came back: the step writes");
  is("(she buys again: the mark goes)", [await buys(), await marked()], ["done", 0]);
  // Another workflow she starts now (the first one already ran for her, and runs once a person).
  await writeForm(statsId, parseForm({ id: "applyform2", name: "Apply again", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] })!);
  store = (await storeForEmail(OWNER))!;
  is("(a second workflow with a note step)", (await saveFlow(store, { name: "Returning", trigger: "form", formId: "applyform2", active: true, steps: [{ delayHours: 0, action: { do: "note", text: "Applied" } }] } as never, { activate: true })).ok, true);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "ana@example.com", { joined: false, form: "applyform2" });
  await sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
  is("the note is written", (await readPersonNotes(statsId, ANA)).map((n) => n.text.startsWith("Applied")), [true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
