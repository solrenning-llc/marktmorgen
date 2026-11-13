/**
 * A product that could not be noted is never answered as noted (Claude 1 cloud's MEDIUM on #2576, lib/contacts.ts
 * noteProduct): after three compare-and-set misses the row did not get the product, but noteProduct answered whether
 * the contact may be written to, so putOnList (lib/buyer-list.ts) enrolled them and marked the checkout done, and no
 * later run noted the product. Now it throws, so putOnList answers "failed", lets its claim go and the next run notes
 * the product once. Real code with the stand-in Redis; the row is changed right after every one of noteProduct's reads.
 */
import { leadsKey, noteProduct, parseContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("owner@noteexh.example", "noteexh", "Note Exhausted", "");
  await ensureStatsId("owner@noteexh.example");
  await ensureListId("owner@noteexh.example");
  const store = (await storeForEmail("owner@noteexh.example"))!;
  const list = store.listId!;
  const key = leadsKey(list);
  const email = "ezra@example.com";
  const row = (lastAt: string) =>
    JSON.stringify({ agreed: true, agreedAt: "", firstAt: "2026-11-01T00:00:00.000Z", lastAt, titles: [], ids: [], source: "buyer", unsub: false, unsubAt: "", t: "", name: "", tags: [], importedAt: "", r: "c" });
  const pipeline = redis.pipeline.bind(redis);
  await pipeline([["HSET", key, email, row("2026-11-01T00:00:00.000Z")]]);

  part("The row changes after every read: the product is not noted, and that is not answered as noted");
  let changes = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await pipeline(commands);
    if (commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === key && changes < 3) {
      changes += 1;
      await pipeline([["HSET", key, email, row(`2026-11-0${changes + 1}T00:00:00.000Z`)]]);
    }
    return answer;
  }) as typeof redis.pipeline;
  const answered = await noteProduct(list, email, "prod000888", "Bread Guide", store).then(
    (mailable) => `answered ${String(mailable)}`,
    (error: unknown) => (error instanceof Error ? error.name : "thrown"),
  );
  redis.pipeline = pipeline;
  is("(control) the row changed after each of the three reads", changes, 3);
  const after = parseContact(((await pipeline([["HGET", key, email]])) as string[])[0])!;
  is("(control) the product is not on the row", after.ids, []);
  is("noteProduct says it could not note it, never that it did", answered, "UnknownReplyError");

  part("Once the row stays still, the product is noted once");
  const again = await noteProduct(list, email, "prod000888", "Bread Guide", store);
  const noted = parseContact(((await pipeline([["HGET", key, email]])) as string[])[0])!;
  is("noted on the next run", [again, noted.ids], [true, ["prod000888"]]);
  done();
}
void main();
