/**
 * Deleting a person from a store deletes the membership invitations an import
 * gave them (lib/move-members.ts, forgetInvitesPerson), and an invitation that
 * is kept but does not read is never taken for "no invitation" (rule 24).
 *
 * forgetInvitesPerson parsed each kept record and passed over one that did not
 * parse, and read a reply of any other shape as "nothing kept": the record, with
 * the address in it, stayed while the erasure answered that it was done. The
 * copy of the person's data (inviteForCopy) already treats such a record as
 * unknown.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { forgetInvitesPerson, inviteField } from "@/lib/move-members";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "owner@example.com";
  await claimHandle(owner, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const made = await addProduct(owner, "The Bread Club", "", "9", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const pid = made.product.id;
  const key = `nl:mv:${store.statsId}`;
  const field = inviteField("dana@example.com", pid);

  part("A kept invitation that does not read is deleted, not passed over");
  // The address is there, but the record lacks its link token: parseInvite cannot read it.
  redis.run(["HSET", key, field, JSON.stringify({ e: "dana@example.com", p: pid, r: 1_800_000_000 })]);
  const gone = await forgetInvitesPerson(store, [pid], "dana@example.com").then((n) => n, () => "threw");
  is("the record holding her address is not kept", redis.run(["HGET", key, field]), null);
  is("and the erasure counts it", gone, 1);

  part("A reply in an unknown shape is never 'nothing kept'");
  redis.run(["HSET", key, field, JSON.stringify({ e: "dana@example.com", p: pid, r: 1_800_000_000, t: "a".repeat(40) })]);
  const real = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) => (commands[0]?.[0] === "HMGET" ? [null] : real.call(redis, commands));
  const unknown = await forgetInvitesPerson(store, [pid], "dana@example.com").then((n) => n, () => "threw");
  redis.pipeline = real;
  is("an HMGET answered with nothing throws, so the erasure is not finished", unknown, "threw");
  is("and the invitation is still there to delete on the next press", typeof redis.run(["HGET", key, field]), "string");
}

main().then(done, (error: unknown) => {
  console.error(error);
  process.exit(1);
});
