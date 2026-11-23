/**
 * Privacy (erase-then-replay), the MEDIUM on #3908 (Claude 1 cloud, second reviewer, 12/11/2026): an old yes
 * replayed after the deletion (the thank-you page of an order placed before it, reloaded; the checkout sweep reading
 * a paid session again) came back non-agreeing, but still WROTE the deleted person's row back: their address and the
 * old order's product, the personal data the erasure had just removed, visible again to the creator (lib/api-read.ts
 * scanLeads), counted in the list's size and charged to the room. A yes from before the deletion is not theirs now:
 * nothing is written for it, as queuePerson already treats it (lib/email-sync.ts, "off"). Synthetic list; MemoryRedis.
 */
import { store as redis } from "./redis-stub";
import { agreedKey, leadsKey, upsertContact } from "@/lib/contacts";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import { done, is, part } from "./check";

const LIST = "c0ffee654321";
const SID = "sidnorow0001";
const WHO = "deleted.again@example.com";
const ORDER_AT = "2026-11-01T10:00:00.000Z";
const ERASED_SECONDS = Date.parse("2026-11-05T12:00:00.000Z") / 1000;
const AFTER = "2026-11-06T09:00:00.000Z";

const print = () => redis.run(["HGET", suppressedKey(LIST), suppressionPrint(LIST, WHO)]);
const row = () => redis.run(["HGET", leadsKey(LIST), WHO]);
const agreedCount = () => redis.run(["GET", agreedKey(LIST)]);
/** Every key the store holds but the list's own (read as its size: a read in the stand-in leaves it empty), so a write anywhere else for the replay (the joined-stores record included) is seen. */
const keys = () => redis.keys().filter((k) => k !== leadsKey(LIST));
function reset(): void {
  redis.clear();
  redis.run(suppressCommand(LIST, WHO, ERASED_SECONDS));
}

async function main(): Promise<void> {
  part("An old yes, repeated after the deletion, writes nothing");
  reset();
  const before = keys();
  const result = await upsertContact(LIST, WHO, { agreed: true, explicit: true, source: "buyer", at: ORDER_AT, sid: SID, title: "Bread course", productId: "prod01" }, null);
  is("the deleted person's row is not written back", row(), null);
  is("nobody is counted as agreeing", agreedCount(), null);
  is("the list holds nobody", redis.run(["HLEN", leadsKey(LIST)]), 0);
  is("no other record is written for it (no joined-stores entry)", keys(), before);
  is("the deletion's print stays, with its second", print(), String(ERASED_SECONDS));
  is("it says nobody joined and no product was noted", result, { joined: false, gotProduct: false, full: false });

  reset();
  await upsertContact(LIST, WHO, { agreed: true, explicit: true, source: "buyer", at: new Date(ERASED_SECONDS * 1000 + 500).toISOString() }, null);
  is("a yes in the very second of the deletion is not known to be after it: no row either", row(), null);

  part("Control: their own yes, given after the deletion, still writes them back as agreeing");
  reset();
  await upsertContact(LIST, WHO, { agreed: true, explicit: true, source: "buyer", at: AFTER }, null);
  is("agreeing again", typeof row() === "string" && (JSON.parse(String(row())) as { agreed: boolean }).agreed, true);
  is("the print is lifted", print(), null);
  done();
}

void main();
