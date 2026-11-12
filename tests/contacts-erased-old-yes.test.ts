/**
 * Privacy (erase-then-replay): a person deleted from a store is kept from being written to again, and only their own
 * yes, given after the deletion, lifts it (lib/contacts.ts upsertContact). A yes repeated from before the deletion —
 * the thank-you page of an order placed earlier reloaded, or the 5-minute checkout sweep re-reading a paid session of
 * the last 24 hours (lib/buyer-list.ts putOnList, at: the order's time) — is not their yes now: it must neither put
 * them back on the list as agreeing nor take the deletion's print away. Before this test the lift compared no time, so
 * the old yes did both. The print holds the second of the deletion (lib/suppression.ts ERASED_PRINT). Synthetic list.
 */
import { store as redis } from "./redis-stub";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { suppressCommand, suppressedKey, suppressionPrint } from "@/lib/suppression";
import { done, is, part } from "./check";

const LIST = "c0ffee123456";
const WHO = "deleted.buyer@example.com";
const ORDER_AT = "2026-11-01T10:00:00.000Z";
const ERASED_SECONDS = Date.parse("2026-11-05T12:00:00.000Z") / 1000;
const AFTER = "2026-11-06T09:00:00.000Z";

const print = () => redis.run(["HGET", suppressedKey(LIST), suppressionPrint(LIST, WHO)]);
const row = () => {
  const raw = redis.run(["HGET", leadsKey(LIST), WHO]);
  return typeof raw === "string" ? (JSON.parse(raw) as { agreed: boolean; agreedAt: string }) : null;
};
function reset(): void {
  redis.clear();
  redis.run(suppressCommand(LIST, WHO, ERASED_SECONDS));
}
async function write(input: Parameters<typeof upsertContact>[2]): Promise<"written" | "threw"> {
  try {
    await upsertContact(LIST, WHO, input, null);
    return "written";
  } catch {
    return "threw";
  }
}

async function main(): Promise<void> {
  part("An old yes, repeated after the deletion");
  reset();
  is("the thank-you page of an order placed before the deletion, reloaded: written as a purchase only", await write({ agreed: true, explicit: true, source: "buyer", at: ORDER_AT }), "written");
  is("not put back as agreeing", row()?.agreed, false);
  is("the deletion's print stays, with its second", print(), String(ERASED_SECONDS));
  is("the same old yes again: still not agreeing, still deleted", [await write({ agreed: true, explicit: true, source: "buyer", at: ORDER_AT }), row()?.agreed, print()], ["written", false, String(ERASED_SECONDS)]);
  reset();
  is("a yes given in the very second of the deletion is not known to be after it", [await write({ agreed: true, explicit: true, source: "buyer", at: new Date(ERASED_SECONDS * 1000 + 500).toISOString() }), row()?.agreed, print()], ["written", false, String(ERASED_SECONDS)]);

  part("Their own yes, given after the deletion, still lifts it");
  reset();
  is("a new order's box checked after the deletion: agreeing again, the print lifted", [await write({ agreed: true, explicit: true, source: "buyer", at: AFTER }), row()?.agreed, row()?.agreedAt, print()], ["written", true, AFTER, null]);
  reset();
  is("a yes given now (no time given, a free download): agreeing again, the print lifted", [await write({ agreed: true, explicit: true, source: "free" }), row()?.agreed, print()], ["written", true, null]);

  reset();
  is("a yes given now, in the very second of the deletion (their own link, opened at once): it lifts it", [await write({ agreed: true, explicit: true, source: "free" }), row()?.agreed, print()], ["written", true, null]);

  part("What never lifts it, as before");
  reset();
  is("a yes that is not their own (an import) never lifts it, whatever its time", [await write({ agreed: true, explicit: false, source: "import", at: AFTER }), row()?.agreed, print()], ["written", false, String(ERASED_SECONDS)]);
  reset();
  is("a purchase without the box records the purchase only", [await write({ agreed: false, explicit: true, source: "buyer", at: AFTER }), row()?.agreed, print()], ["written", false, String(ERASED_SECONDS)]);

  part("A print whose second does not read is never taken as an old one");
  for (const [what, value] of [["text", "yesterday"], ["a fraction", "1730.5"], ["nothing", ""]] as const) {
    reset();
    redis.run(["HSET", suppressedKey(LIST), suppressionPrint(LIST, WHO), value]);
    is(`a print of ${what}: a yes with a time to compare changes nothing and writes nothing`, [await write({ agreed: true, explicit: true, source: "buyer", at: AFTER }), row(), print()], ["threw", null, value]);
  }
  done();
}

void main();
