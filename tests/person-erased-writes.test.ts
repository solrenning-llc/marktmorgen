/**
 * C3-123 (c): a task or a note about a person, prepared before that person
 * was deleted from the store, never writes anything about them again; one
 * prepared after (they came back) is written as for anyone, and takes the
 * deletion's mark away in the same step. Through the real routes
 * (app/api/store/person-tasks, app/api/store/person) and a workflow's note
 * step, on the in-memory Redis, with what each save sends held under the one
 * studio request it takes.
 */
import { NextRequest } from "next/server";
import { POST as tasksPost } from "@/app/api/store/person-tasks/route";
import { POST as personPost } from "@/app/api/store/person/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { ERASED_CLOCK_MS, ERASED_GUARD_CALLS, WRITE_TASKS_CALLS, erasedKey, forgetCrmPerson, readPersonTasks } from "@/lib/crm";
import { ADD_PERSON_NOTE, forgetNotesPerson, readPersonNotes } from "@/lib/buyer-profile";
import { ERASERS } from "@/lib/person-erasure";
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { personKey } from "@/lib/person-key";
import { dataUsed } from "@/lib/store-data";
import { utf8Length } from "@/lib/store-data-rules";
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
  const send = async (route: typeof tasksPost, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const task = (body: Record<string, unknown>) => send(tasksPost, "/api/store/person-tasks", { person: ANA, ...body });
  const note = (body: Record<string, unknown>) => send(personPost, "/api/store/person", { action: "note", person: ANA, ...body });
  const used = async () => (await dataUsed(store))?.used ?? 0;
  // The deletion's own CRM parts, in the order lib/person-erasure.ts runs them: the CRM (which leaves the mark) before the notes.
  const erase = async () => {
    await forgetCrmPerson(statsId, ANA, "ana@example.com", store);
    await forgetNotesPerson(statsId, ANA);
  };
  // A mark's time put back, as if the deletion were a minute old (a test's clock does not move by itself).
  const markAgo = async () => {
    const [at] = await redis.pipeline([["GET", mark]]);
    await redis.pipeline([["SET", mark, String(Number(at) - ERASED_CLOCK_MS - 60_000), "EX", 3600]]);
  };

  part("The deletion leaves its mark before the notes are taken away");
  const order = ERASERS.map((e) => e.module);
  is("the CRM's part runs before the notes'", order.indexOf("lib/crm.ts") >= 0 && order.indexOf("lib/crm.ts") < order.indexOf("lib/buyer-profile.ts"), true);

  part("Before: a task and a note written");
  const drawn = Date.now();
  is("a task", (await task({ action: "add", text: "Send the workbook", preparedAt: drawn })).status, 200);
  is("a note", (await note({ text: "Asked about the course.", preparedAt: drawn })).status, 200);
  is("both kept", [(await readPersonTasks(statsId, ANA)).length, (await readPersonNotes(statsId, ANA)).length], [1, 1]);
  await erase();
  const empty = await used();
  is("the deletion took them", [(await readPersonTasks(statsId, ANA)).length, (await readPersonNotes(statsId, ANA)).length], [0, 0]);

  part("A task or note from a page drawn before the deletion, saved after it: refused, nothing written");
  const lateTask = await task({ action: "add", text: "Call back", preparedAt: drawn });
  is("the task: 404 gone, with what to do", [lateTask.status, lateTask.body.error, lateTask.body.message], [404, "gone", "This person is no longer in your store, so nothing was saved. Reload the page."]);
  const lateNote = await note({ text: "Called back.", preparedAt: drawn });
  is("the note: 404 unknown", [lateNote.status, lateNote.body.error], [404, "unknown"]);
  is("one that sends no time is taken as drawn before", [(await task({ action: "add", text: "Call back" })).status, (await note({ text: "Called back." })).status], [404, 404]);
  is("so is one drawn within the clocks' difference of it", [(await task({ action: "add", text: "Call back", preparedAt: Date.now() })).status, (await note({ text: "Called back.", preparedAt: Date.now() })).status], [404, 404]);
  is("nothing about them is kept", [await readPersonTasks(statsId, ANA), await readPersonNotes(statsId, ANA)], [[], []]);
  is("the room taken for them is given back", await used(), empty);
  is("the mark stays", (await redis.pipeline([["EXISTS", mark]]))[0], 1);

  part("A note whose room was taken, with the deletion in between, then written: refused");
  await markAgo();
  await redis.pipeline([["DEL", mark]]);
  const prepared = Date.now();
  const original = redis.pipeline;
  let armed = true;
  redis.pipeline = async (commands) => {
    if (armed && roomOnly(commands)) {
      armed = false;
      await erase();
    }
    return original.call(redis, commands);
  };
  const raced = await note({ text: "Typed before the deletion.", preparedAt: prepared });
  redis.pipeline = original;
  is("the deletion ran in between, and the note is refused", [armed, raced.status], [false, 404]);
  is("not written", await readPersonNotes(statsId, ANA), []);

  part("A task change that started before the deletion and wrote after it: refused");
  await redis.pipeline([["DEL", mark]]);
  const taskPrepared = Date.now();
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
  const racedTask = await task({ action: "add", text: "Typed before the deletion", preparedAt: taskPrepared });
  redis.pipeline = original;
  await erasing;
  is("refused: gone", [armed, racedTask.status, racedTask.body.error], [false, 404, "gone"]);
  is("not written", await readPersonTasks(statsId, ANA), []);
  is("and no room counted for it", await used(), empty);

  part("Someone who came back: a task and a note from a page drawn after the deletion are written, and the mark goes");
  await markAgo();
  const back = Date.now();
  const backTask = await task({ action: "add", text: "Welcome back", preparedAt: back });
  is("the task is written", [backTask.status, (await readPersonTasks(statsId, ANA)).map((t) => t.text)], [200, ["Welcome back"]]);
  is("the mark is gone", (await redis.pipeline([["EXISTS", mark]]))[0], 0);
  await erase();
  await markAgo();
  const backNote = await note({ text: "Bought again.", preparedAt: Date.now() });
  is("the note is written", [backNote.status, (await readPersonNotes(statsId, ANA)).map((n) => n.text)], [200, ["Bought again."]]);
  is("and the mark is gone", (await redis.pipeline([["EXISTS", mark]]))[0], 0);

  part("What a task or a note sends, within the one studio request each save takes");
  const measure = async (run: () => Promise<{ status: number }>) => {
    let commands = 0;
    let inside = 0;
    let bytes = 0;
    const size = (v: unknown): number => (typeof v === "string" ? utf8Length(v) : typeof v === "number" ? String(v).length : Array.isArray(v) ? v.reduce((n: number, x) => n + size(x), 0) : v && typeof v === "object" ? size(Object.values(v)) : 0);
    redis.pipeline = async (sent) => {
      commands += sent.length;
      // Inside the scripts that write about a person: the mark read (and taken away), then the writes.
      for (const c of sent) {
        if (c[0] !== "EVAL") continue;
        if (c[1] === ADD_PERSON_NOTE) inside += ERASED_GUARD_CALLS + 4;
        else if (String(c[1]).startsWith("-- marktmorgen:crm-tasks-write:")) inside += WRITE_TASKS_CALLS;
      }
      const replies = await original.call(redis, sent);
      bytes += size(sent) + size(replies);
      return replies;
    };
    try { return { status: (await run()).status, commands, inside, bytes }; } finally { redis.pipeline = original; }
  };
  for (const [what, run] of [["a task", () => task({ action: "add", text: "x".repeat(200), preparedAt: Date.now() })], ["a note", () => note({ text: "x".repeat(1_000), preparedAt: Date.now() })]] as const) {
    const m = await measure(run);
    is(`${what}: saved, ${m.commands} commands sent and ${m.inside} inside its script, ${m.bytes} bytes: within twenty and the count's, and 50,000`, [m.status, m.commands + m.inside <= 24, m.bytes <= 50_000], [200, true, true]);
  }

  part("A workflow's note step taken before the deletion writes nothing about them after it");
  await erase();
  await redis.pipeline([["DEL", mark]]);
  await writeForm(statsId, parseForm({ id: "applyform1", name: "Apply", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] })!);
  const saved = await saveFlow(store, { name: "Applicants", trigger: "form", formId: "applyform1", active: true, steps: [{ delayHours: 0, action: { do: "note", text: "Applied" } }] } as never, { activate: true });
  is("(a workflow with a note step)", saved.ok, true);
  await upsertContact(store.listId!, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "ana@example.com", { joined: false, form: "applyform1" });
  armed = true;
  redis.pipeline = async (commands) => {
    // The step is taken; its note's room is being taken when the deletion runs.
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

  part("Taken after the deletion (they signed up again): the step writes, and the mark goes");
  await markAgo();
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "ana@example.com", { joined: false, form: "applyform1" });
  await sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
  is("the note is written", (await readPersonNotes(statsId, ANA)).map((n) => n.text.startsWith("Applied")), [true]);
  is("the mark is gone", (await redis.pipeline([["EXISTS", mark]]))[0], 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
