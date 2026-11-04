/**
 * A contact written with the whole store as its room is charged to the
 * store's data room (lib/contacts.ts, needContacts). It used to be told from
 * an order's write by having an `order` field, which every store record has
 * (the order of its page's parts), so a sign-up, an import, a label set in
 * bulk or by the API was never counted (edge tests of 4 November 2026). An
 * order's write is marked only by orderRoom and still goes through
 * lib/order-data.ts.
 */
import { store as redis } from "./redis-stub";
import { changeLabels, importContacts, orderRoom, upsertContact } from "@/lib/contacts";
import { dataKey } from "@/lib/store-data";
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
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
