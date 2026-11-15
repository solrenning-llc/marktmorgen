/**
 * Codex V on #3925 (MEDIUM, lib/contacts.ts tokensFor), RED before the fix: tokensFor read the store's deletion
 * prints, and only then wrote the unsubscribe link's record and the contact's token (a checked write of the row
 * alone). An erasure writes the print first and deletes the row after it (lib/person-erasure.ts); when the print
 * landed between tokensFor's read and its write, the row still held what was read, so the write went through and
 * the deleted person was handed a link, and so an email. Now the row's check, the print's check at write time, the
 * link's record and the row are one script: a print written by then means nothing is written and no link is given.
 * Synthetic data only.
 */
import { leadsKey, tokenKey, tokensFor, upsertContact } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "tokens-race@example.com";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "tokens-race", "Tokens Race", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_TokRace0001", subscriptionId: "sub_TokRace0001", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  for (const name of ["ana", "ben"]) await upsertContact(listId, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);

  part("Deleted from the store after the prints were read, before the link was written: no link");
  const real = redis.pipeline.bind(redis);
  let erased = false;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    const out = await real(batch);
    // The erasure's first step lands right after tokensFor read who was deleted, before its write.
    if (!erased && batch.some((c) => c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:"))) {
      erased = true;
      await real([suppressCommand(listId, "ben@example.com", Math.floor(Date.now() / 1000))]);
    }
    return out;
  }) as typeof redis.pipeline;
  const links = await tokensFor(listId, ["ana@example.com", "ben@example.com"], store.handle);
  redis.pipeline = real as typeof redis.pipeline;
  is("the print was written between the read and the write", erased, true);
  is("only the person not deleted gets a link", [...links.keys()].sort(), ["ana@example.com"]);
  const [row] = await real([["HGET", leadsKey(listId), "ben@example.com"]]);
  const kept = typeof row === "string" ? (JSON.parse(row) as { t?: string }).t : undefined;
  is("the deleted person's row was given no token", kept ?? "", "");
  const anaLink = links.get("ana@example.com");
  const [record] = anaLink ? await real([["GET", tokenKey(anaLink)]]) : [null];
  is("the person not deleted has a link that leads somewhere", typeof record === "string" && record.startsWith(`${listId}|ana@example.com|`), true);

  part("A send right after finds the deleted person still without a link");
  const again = await tokensFor(listId, ["ana@example.com", "ben@example.com"], store.handle);
  is("the same link for the person not deleted, none for the other", [...again.entries()], [["ana@example.com", anaLink]]);
  done();
}

void main();
