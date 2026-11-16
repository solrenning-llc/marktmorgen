/**
 * An erasure writes the address's fingerprint first (lib/person-erasure.ts),
 * "so whatever happens next, they are never written to again", and then
 * deletes the contact's row. When that second step did not happen (it failed,
 * or a send was between the two), the row still said agreed, and a list
 * email or a sequence step handed it an unsubscribe link and sent: the send
 * (lib/mail.ts sendTo, through tokensFor) read only the row. Now tokensFor
 * reads the fingerprints in the same round trip and gives no link, so nothing
 * is sent, to anybody deleted from the store. Synthetic data only.
 */
import { leadsKey, parseContact, tokensFor, upsertContact } from "@/lib/contacts";
import { suppressCommand } from "@/lib/suppression";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "tokens-erased@example.com";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "tokens-erased", "Tokens Erased", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_TokErased1", subscriptionId: "sub_TokErased1", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  for (const name of ["ana", "ben"]) await upsertContact(listId, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);

  part("Deleted from the store, with the row not yet gone: no link, so no email");
  await redis.pipeline([suppressCommand(listId, "ben@example.com", Math.floor(Date.now() / 1000))]);
  const links = await tokensFor(listId, ["ana@example.com", "ben@example.com"], store.handle);
  is("only the person not deleted gets a link", [...links.keys()].sort(), ["ana@example.com"]);

  part("An unreadable answer about who was deleted is unknown, never nobody");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: (string | number)[][]) => {
    const out = await real(batch);
    return batch.map((c, i) => (c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:") ? "?" : out[i]));
  }) as typeof redis.pipeline;
  const unknown = await tokensFor(listId, ["ana@example.com"], store.handle).then(() => "answered", (e: Error) => e.name);
  redis.pipeline = real as typeof redis.pipeline;
  is("thrown as unknown, so the send waits", unknown, "UnknownReplyError");

  // Codex V on #3925 (6891381661, MÉDIO 1; Codex G and X2 before it): the prints were read, then the token's record
  // made and the row written with a check of the row alone. An erasure that wrote its print in that moment, its row
  // not yet deleted, still got a link and an email, and kept an unsubscribe record naming the address.
  part("Deleted between the read and the write: no link, no token on the row, no record naming the address");
  await upsertContact(listId, "carl@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  let erased = false;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    const writesLink = batch.some((c) => (c[0] === "SET" && String(c[1]).startsWith("nl:mail:unsub:")) || (c[0] === "EVAL" && String(c[1]).includes("cas-hset")));
    if (writesLink && !erased) {
      erased = true;
      await real([suppressCommand(listId, "carl@example.com", Math.floor(Date.now() / 1000))]);
    }
    return real(batch);
  }) as typeof redis.pipeline;
  const raced = await tokensFor(listId, ["carl@example.com"], store.handle);
  redis.pipeline = real as typeof redis.pipeline;
  is("control: the erasure came between the read and the write", erased, true);
  is("no link is handed out", [...raced.keys()], []);
  is("the row holds no token", parseContact((await real([["HGET", leadsKey(listId), "carl@example.com"]]))[0])?.t ?? "", "");
  const records = ((await real([["SCAN", "0", "MATCH", "nl:mail:unsub:*", "COUNT", "10000"]]))[0] as [string, string[]])[1];
  const naming = (await Promise.all(records.map(async (k) => String((await real([["GET", k]]))[0])))).filter((v) => v.includes("|carl@example.com|"));
  is("no unsubscribe record names the address", naming, []);
  done();
}

void main();
