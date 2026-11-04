/**
 * A contact written with the whole store as its room is charged to the
 * store's data room (lib/contacts.ts, needContacts). It used to be told from
 * an order's write by having an `order` field, which every store record has
 * (the order of its page's parts), so a sign-up, an import, a label set in
 * bulk or by the API was never counted (edge tests of 4 November 2026). An
 * order's write is marked only by orderRoom and still goes through
 * lib/order-data.ts.
 */
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { changeLabels, importContacts, orderRoom, upsertContact } from "@/lib/contacts";
import { dataKey, dataUsed } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const OWNER = "contacts-room@example.com";
  await claimHandle(OWNER, "contactsroom", "Contacts Room", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  is("a store record has an `order` field, which is why it was taken for an order's", "order" in store, true);
  const slot = (name: string) => Number(redis.run(["HGET", dataKey(store)!, name]) ?? 0);

  part("The whole store as the room: charged before writing");
  const before = slot("ct");
  await upsertContact(store.listId!, "new.signup@example.com", { agreed: true, explicit: true, source: "free", sid: store.sid, at: new Date().toISOString() }, store);
  is("a sign-up takes room in the contacts' slot", slot("ct") > before, true);
  const afterSignup = slot("ct");
  await importContacts(store.listId!, ["one@example.com", "two@example.com"], store);
  is("an import takes room too", slot("ct") > afterSignup, true);
  const afterImport = slot("ct");
  await changeLabels(store.listId!, ["one@example.com", "two@example.com"], (tags) => [...tags, ...Array.from({ length: 10 }, (_, i) => `Label number ${i} for the spring workshop`)], store);
  is("a label set takes what it grows the record by", slot("ct") > afterImport, true);

  part("An order's write: marked by orderRoom, charged where an order's records are");
  const ordersBefore = slot("o");
  const contactsBefore = slot("ct");
  await upsertContact(store.listId!, "buyer@example.com", { agreed: false, explicit: false, source: "buyer", sid: store.sid, productId: "prod_x", title: "X", at: new Date().toISOString() }, orderRoom(store));
  is("counted with the order's records", slot("o") > ordersBefore, true);
  is("and not twice in the contacts' slot", slot("ct"), contactsBefore);
  const legacyBefore = slot("o");
  await upsertContact(store.listId!, "buyer2@example.com", { agreed: false, explicit: false, source: "buyer", sid: store.sid, productId: "prod_x", title: "X", at: new Date().toISOString() }, { order: store });
  is("the older form, an object holding only `order`, is still an order's", [slot("o") > legacyBefore, slot("ct")], [true, contactsBefore]);
  part("A paste that fills the room partway: what went in is said, and nothing else is written");
  const used = await dataUsed(store);
  // All but room for about one chunk of 500 taken, as a store near its plan's room would be.
  const fill = contentRoomFor(store, Date.now() / 1000) - used!.used - 600_000;
  redis.run(["HINCRBY", dataKey(store)!, "ct", fill]);
  redis.run(["HINCRBY", dataKey(store)!, "#", fill]);
  const pasted = Array.from({ length: 1_200 }, (_, i) => `paste${i}@example.com`);
  const answer = await importContacts(store.listId!, pasted, store);
  is("some went in, the rest are said to be left out, and why", [answer.added > 0, answer.roomFull !== undefined, (answer.roomFull?.left ?? 0) > 0, answer.added + (answer.roomFull?.left ?? 0) + answer.already], [true, true, true, pasted.length]);
  const route = readFileSync("app/api/store/mail/route.ts", "utf8");
  is("the paste starts the ramp for those added, full or not, and says so", route.includes("await startRamp(healthId(store), added);") && route.includes("roomFull: roomFull ?? null"), true);
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the studio says how many were not added and why", studio.includes("were not added: ${String(roomFull.message"), true);
  const imports = readFileSync("lib/imports.ts", "utf8");
  is("a file of contacts that fills the room starts the ramp for those already in", imports.includes('if (job.kind === "contacts") await startRamp(job.sid, job.counts.added);\n            job.state = "failed";') || /DataRoomError[\s\S]{0,400}if \(job\.kind === "contacts"\) await startRamp\(job\.sid, job\.counts\.added\)/.test(imports), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
