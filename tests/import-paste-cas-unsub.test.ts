/**
 * Pasted addresses (lib/contacts.ts importContacts) are written only where the
 * contact is still as it was read, as a file's rows already are
 * (importContactRows, Codex G on #3116). The paste read each address, took
 * room, then wrote with a plain HSET: somebody who unsubscribed, bounced or
 * complained in that moment was written back as agreed, and emailed again.
 * Now each write checks what it read in one step (CAS_HSET), and a contact
 * changed meanwhile stands as it is now. Synthetic data only; the moment is
 * made by writing the row just before the import's write runs.
 */
import { importContacts, leadsKey, listCounts, parseContact, upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let between: (() => Promise<void>) | null = null;
// Runs `between` once, right before the first batch that writes the list's rows (a plain HSET or the checked script).
redis.pipeline = (async (batch: Command[]) => {
  if (between && batch.some((c) => (c[0] === "HSET" && String(c[1]).startsWith("nl:store:leads:")) || (c[0] === "EVAL" && String(c[1]).includes("contact-cas-hset")))) {
    const run = between;
    between = null;
    await run();
  }
  return real(batch);
}) as typeof redis.pipeline;

const OWNER = "paste-cas@example.com";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "paste-cas", "Paste Cas", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PasteCas01", subscriptionId: "sub_PasteCas01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  // A buyer who did not tick the box: on the list, not agreed, not left.
  await upsertContact(listId, "quiet@example.com", { agreed: false, explicit: false, source: "buyer" }, ROOM);
  const row = async () => parseContact((await real([["HGET", leadsKey(listId), "quiet@example.com"]]))[0]);
  const before = await row();
  if (!before) throw new Error("no row");

  part("An address that left while the paste was being written stays left");
  between = async () => {
    await real([["HSET", leadsKey(listId), "quiet@example.com", JSON.stringify({ ...before, unsub: true, unsubAt: new Date().toISOString() })]]);
  };
  const answer = await importContacts(listId, ["quiet@example.com", "new@example.com"], store);
  const after = await row();
  is("still unsubscribed, not written back as agreed", [after?.unsub, after?.agreed], [true, false]);
  is("only the new address was added", answer.added, 1);
  is("the list counts one who agreed", (await listCounts(listId)).agreed, 1);

  part("Without anything in between, the paste adds as before");
  const plain = await importContacts(listId, ["third@example.com"], store);
  is("added", [plain.added, (await listCounts(listId)).agreed], [1, 2]);
  done();
}

void main();
