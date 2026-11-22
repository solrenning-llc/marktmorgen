/** Partial Redis evidence must never put an erased person back on a list. */
import { importContactRows, importContacts, leadsKey, previewContactRows, agreedKey, MAX_LEADS, type ImportedContact } from "@/lib/contacts";
import { addRows, finishUpload, runImport, startImport } from "@/lib/imports";
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
const list = "contacts-evidence-test";
const rows: ImportedContact[] = [
  { email: "new@example.com", name: "New", tags: [] },
  { email: "erased@example.com", name: "Erased", tags: [] },
];
const emails = rows.map((r) => r.email);
const partials: [string, (reply: unknown[]) => unknown[]][] = [
  ["missing suppression command", (r) => r.slice(0, -1)],
  ["extra command", (r) => [...r, null]],
  ["short suppression list", (r) => [...r.slice(0, -1), [null]]],
  ["long suppression list", (r) => [...r.slice(0, -1), [null, null, null]]],
  ["non-array suppression list", (r) => [...r.slice(0, -1), null]],
  ["undefined suppression slot", (r) => [...r.slice(0, -1), [null, undefined]]],
  ["numeric suppression slot", (r) => [...r.slice(0, -1), [null, 0]]],
  ["object suppression slot", (r) => [...r.slice(0, -1), [null, {}]]],
  ["sparse suppression list", (r) => [...r.slice(0, -1), new Array(2)]],
  ["missing contact slots", (r) => [...r.slice(0, -2), [], r.at(-1)]],
  ["extra contact slot", (r) => [...r.slice(0, -2), [null, null, null], r.at(-1)]],
  ["non-array contacts", (r) => [...r.slice(0, -2), {}, r.at(-1)]],
  ["undefined contact slot", (r) => [...r.slice(0, -2), [null, undefined], r.at(-1)]],
  ["numeric contact slot", (r) => [...r.slice(0, -2), [0, null], r.at(-1)]],
  ["boolean contact slot", (r) => [...r.slice(0, -2), [false, null], r.at(-1)]],
  ["sparse contact list", (r) => [...r.slice(0, -2), new Array(2), r.at(-1)]],
];

async function main(): Promise<void> {
  for (const mode of ["file", "paste", "preview"] as const) {
    part(`${mode}: complete evidence or no import`);
    const invoke = () => mode === "file" ? importContactRows(list, rows, ROOM)
      : mode === "paste" ? importContacts(list, emails, ROOM) : previewContactRows(list, rows);
    for (const [name, change] of partials) {
      redis.clear();
      redis.run(suppressCommand(list, emails[1]));
      const original = redis.pipeline.bind(redis);
      let intercepted = 0;
      let writes = 0;
      redis.pipeline = async (commands: Command[]) => {
        const isRead = commands.some((c) => c[0] === "HMGET" && c[1] === leadsKey(list))
          && commands.some((c) => c[0] === "HMGET" && c[1] === `nl:erased:${list}`);
        if (isRead) { intercepted += 1; return change(await original(commands)); }
        if (commands.some((c) => !["HLEN", "HMGET", "HGET"].includes(String(c[0])))) writes += 1;
        return original(commands);
      };
      let error: unknown;
      try { await invoke(); } catch (caught) { error = caught; } finally { redis.pipeline = original; }
      is(`${name}: refused as unknown with retry wording`, [intercepted, error instanceof Error && /not imported.*try again/i.test(error.message)], [1, true]);
      is(`${name}: no writes, no restored contact, no agreed counter`, [writes, redis.run(["HLEN", leadsKey(list)]), redis.run(["GET", agreedKey(list)])], [0, 0, null]);
    }
    for (const badCount of [undefined, null, "0", -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      redis.clear();
      redis.run(suppressCommand(list, emails[1]));
      const original = redis.pipeline.bind(redis);
      redis.pipeline = async (commands: Command[]) => {
        const reply = await original(commands);
        return commands[0]?.[0] === "HLEN" ? [badCount, ...reply.slice(1)] : reply;
      };
      let refused = false;
      try { await invoke(); } catch { refused = true; } finally { redis.pipeline = original; }
      is(`unconfirmed HLEN ${String(badCount)}: no mutation`, [refused, redis.run(["HLEN", leadsKey(list)])], [true, 0]);
    }
    redis.clear();
    redis.run(suppressCommand(list, emails[1]));
    const result = await invoke();
    if (mode === "file") is("valid null and string slots preserve the erased person's opt-out", result, ["added", "left"]);
    else if (mode === "paste") is("valid paste adds only the new address", result, { added: 1, already: 1, full: false });
    else is("valid preview distinguishes the new person from the erased person", result, { outcomes: [{ outcome: "added", fresh: true }, { outcome: "left", fresh: false }], room: MAX_LEADS });
    is("erased contact remains absent", redis.run(["HGET", leadsKey(list), emails[1]]), null);
    is("erasure marker is kept", typeof redis.run(["HGET", suppressedKey(list), suppressionPrint(list, emails[1])]), "string");
  }
  part("The real import job keeps its place and retries the same rows");
  redis.clear();
  const owner = "contacts-retry@example.com";
  await claimHandle(owner, "contactsretry", "Contacts Retry", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const store = (await storeForEmail(owner))!;
  const realList = store.listId!;
  redis.run(suppressCommand(realList, emails[1]));
  const start = await startImport(store, owner, "contacts", { expected: 2, file: "contacts.csv", agreed: true });
  if (!start.ok) throw new Error(`import did not start: ${start.reason}`);
  await addRows(store, start.job.id, rows.map((r, i) => [String(i + 2), r.email, r.name, ""]));
  await finishUpload(store, start.job.id);
  const original = redis.pipeline.bind(redis);
  const log = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  redis.pipeline = async (commands: Command[]) => {
    const reply = await original(commands);
    return commands.some((c) => c[0] === "HMGET" && c[1] === `nl:erased:${realList}`) ? reply.slice(0, -1) : reply;
  };
  try {
    const held = await runImport(start.job.id, Date.now() + 10_000);
    is("partial evidence does not advance or mark either row imported", [held?.done, held?.counts.added, held?.cursor], [0, 0, { batch: 0, row: 0 }]);
    is("the job records a retryable unknown reading", errors.some((args) => args.some((value) => value instanceof Error && /not imported.*try again/i.test(value.message))), true);
    is("no contact is written while erasure evidence is unknown", redis.run(["HLEN", leadsKey(realList)]), 0);
  } finally { redis.pipeline = original; console.error = log; }
  const finished = await runImport(start.job.id, Date.now() + 10_000);
  is("the same rows can finish after a confirmed reading", [finished?.state, finished?.done, finished?.counts.added, finished?.counts.skipped], ["done", 2, 1, 1]);
  is("the erased person is still absent after retry", redis.run(["HGET", leadsKey(realList), emails[1]]), null);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
