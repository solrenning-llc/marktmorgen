/**
 * The contact imports (importContacts for a pasted list, importContactRows for a file and the API's addLead,
 * previewContactRows for the file's preview) read two things before deciding each address: the store's prints of the
 * people deleted from it (nl:erased:<listId>) and what the list already holds for the address. Both were read loosely
 * (rule 24): a reply that was not a list became an empty one, and a missing slot read as "nothing".
 *
 * - An unknown prints reply read as "nobody here was deleted": a person deleted from the store was put back on its list
 *   as agreeing, against the promise that no import or API call puts them back (lib/suppression.ts), and the API's
 *   addLead then started every "joined" sequence for them.
 * - An unknown rows reply read as "not on the list": an address that had unsubscribed was written over by the pasted
 *   import (a plain HSET) as agreeing again, so every later sequence step and broadcast reached them.
 *
 * Now both are read exactly: an answer in another shape throws, nothing is written, and the import says it could not
 * be finished. Controls: exact answers still add a new address, still leave a deleted or unsubscribed one alone.
 * Synthetic data only; nothing is sent.
 */
import { store as redis } from "./redis-stub";
import { importContactRows, importContacts, leadsKey, parseContact, previewContactRows, upsertContact } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { done, is, part } from "./check";

const original = redis.pipeline.bind(redis);
/** Answers the HMGET on `key` with `shape(real reply)`; every other command as it is. */
function answering(key: string, shape: (reply: unknown) => unknown) {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    return replies.map((reply, i) => (commands[i]?.[0] === "HMGET" && commands[i]?.[1] === key ? shape(reply) : reply));
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = original;
};
const outcome = (p: Promise<unknown>) => p.then((v) => ({ ok: v }), () => "refused");

const SHAPES: [string, (reply: unknown) => unknown][] = [
  ["a reply that is not a list", () => "OK"],
  ["an empty list", () => []],
  ["no reply at all", () => undefined],
  ["an entry that is an object", (reply) => (Array.isArray(reply) ? reply.map(() => ({ x: 1 })) : reply)],
];

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "contacts-exact@example.com";
  await claimHandle(OWNER, "contactsexact", "Contacts Exact", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId!;
  const erasedKey = `nl:erased:${listId}`;
  const row = (email: string) => parseContact(redis.run(["HGET", leadsKey(listId), email]));

  const GONE = "gone@example.com";
  await redis.pipeline([suppressCommand(listId, GONE)]);

  part("A deleted person: an unknown prints answer never reads as \"not deleted\"");
  for (const [label, shape] of SHAPES) {
    answering(erasedKey, shape);
    const pasted = await outcome(importContacts(listId, [GONE], store));
    const file = await outcome(importContactRows(listId, [{ email: GONE, name: "", tags: [], consent: "agreed" }], store));
    const preview = await outcome(previewContactRows(listId, [{ email: GONE, name: "", tags: [], consent: "agreed" }]));
    restore();
    is(`(${label}) the pasted import is refused`, pasted, "refused");
    is(`(${label}) the file import is refused`, file, "refused");
    is(`(${label}) the preview is refused`, preview, "refused");
    is(`(${label}) the deleted person is not put back`, row(GONE), null);
  }

  part("An unsubscribed address: an unknown rows answer never reads as \"not on the list\"");
  const LEFT = "left@example.com";
  await upsertContact(listId, LEFT, { agreed: true, explicit: true, source: "free", sid: store.sid, at: new Date().toISOString() }, store);
  const kept = parseContact(redis.run(["HGET", leadsKey(listId), LEFT]))!;
  redis.run(["HSET", leadsKey(listId), LEFT, JSON.stringify({ ...kept, unsub: true, unsubAt: new Date().toISOString() })]);
  const before = redis.run(["HGET", leadsKey(listId), LEFT]);
  for (const [label, shape] of SHAPES) {
    answering(leadsKey(listId), shape);
    const pasted = await outcome(importContacts(listId, [LEFT], store));
    const file = await outcome(importContactRows(listId, [{ email: LEFT, name: "", tags: [], consent: "agreed" }], store));
    restore();
    is(`(${label}) the pasted import is refused`, pasted, "refused");
    is(`(${label}) the file import is refused`, file, "refused");
    is(`(${label}) the unsubscribe is kept as it was`, redis.run(["HGET", leadsKey(listId), LEFT]), before);
  }

  part("Controls: exact answers");
  const pasted = await importContacts(listId, ["new@example.com", GONE, LEFT], store);
  is("the new address is added, the deleted and the unsubscribed ones are left alone", pasted.added, 1);
  is("the new address agrees", row("new@example.com")?.agreed, true);
  is("the deleted person stays out", row(GONE), null);
  is("the unsubscribe stays", row(LEFT)?.unsub, true);
  const file = await importContactRows(listId, [{ email: "file@example.com", name: "", tags: [], consent: "agreed" }, { email: GONE, name: "", tags: [], consent: "agreed" }], store);
  is("the file adds the new address only", file[0], "added");
  is("the deleted person stays out of the file import", row(GONE), null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
