/**
 * A contact's name brought in by an import is kept on one line, its runs of spaces
 * made one, the way the API keeps a name it is given (lib/api-write.ts addLead).
 * Before, a quoted cell with a line break ("Ann⏎Lee") was kept with the break, and
 * the email-tool sync later removed it, sending "AnnLee" as the first name.
 * Synthetic data only.
 */
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { addRows, finishUpload, previewImport, runImport, startImport } from "@/lib/imports";
import { leadsKey, parseContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;
const OWNER = "names-owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "namestore", "Name Store", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId!;
  const contacts = [
    ["2", "ann@example.com", "Ann\nLee", "", ""],
    ["3", "bo@example.com", "  Bo \t  Smith\r\n", "", ""],
    ["4", "cy@example.com", "Cy", "", ""],
  ];
  const input = { expected: contacts.length, file: "contacts.csv", agreed: true, consentColumn: false, tags: [], source: "csv" as const };
  const preview = await previewImport(store, "contacts", input, contacts);
  is("the dry run takes every row", preview.ok ? preview.rows.map((r) => r[1]) : preview.reason, ["added", "added", "added"]);
  const started = await startImport(store, OWNER, "contacts", input);
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  await addRows(store, started.job.id, contacts);
  await finishUpload(store, started.job.id);
  let job = await runImport(started.job.id, Date.now() + 30_000);
  for (let i = 0; i < 10 && job && job.state !== "done"; i += 1) job = await runImport(started.job.id, Date.now() + 30_000);
  const name = async (email: string) => parseContact((await redis.pipeline([["HGET", leadsKey(listId), email]]))[0])?.name;
  is("a line break in a name is a space", await name("ann@example.com"), "Ann Lee");
  is("runs of spaces and tabs are one space", await name("bo@example.com"), "Bo Smith");
  is("a plain name is as typed", await name("cy@example.com"), "Cy");
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
