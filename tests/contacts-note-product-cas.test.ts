/**
 * A product noted on a contact counted in the contacts' slot is written only over the row it read (Claude 1 cloud's
 * LEVE on #2576, lib/contacts.ts noteProduct): it was a plain HSET of a row read before, so a label taken off in
 * between came back, and the slot was counted from a row that was no longer there. Now the row is written with the
 * contacts' compare-and-set and read again when it changed; the slot follows what was written. Real code with the
 * stand-in Redis; the label change is made right after noteProduct's read.
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
  await claimHandle("owner@notecas.example", "notecas", "Note CAS", "");
  await ensureStatsId("owner@notecas.example");
  await ensureListId("owner@notecas.example");
  const store = (await storeForEmail("owner@notecas.example"))!;
  const list = store.listId!;
  const key = leadsKey(list);
  const email = "dora@example.com";
  const row = (tags: string[]) =>
    JSON.stringify({ agreed: true, agreedAt: "", firstAt: "2026-11-01T00:00:00.000Z", lastAt: "2026-11-01T00:00:00.000Z", titles: [], ids: [], source: "buyer", unsub: false, unsubAt: "", t: "", name: "", tags, importedAt: "", r: "c" });
  const pipeline = redis.pipeline.bind(redis);
  await pipeline([["HSET", key, email, row(["vip", "early"])]]);

  part("A label taken off between the read and the write");
  let once = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await pipeline(commands);
    if (once && commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === key) {
      once = false;
      await pipeline([["HSET", key, email, row(["early"])]]);
    }
    return answer;
  }) as typeof redis.pipeline;
  await noteProduct(list, email, "prod000777", "Spice Chart", store);
  redis.pipeline = pipeline;
  const after = parseContact(((await pipeline([["HGET", key, email]])) as string[])[0])!;
  is("the label taken off stays off", after.tags, ["early"]);
  is("and the product is noted on the row as it now stands", after.ids, ["prod000777"]);

  // Codex X5's MEDIUM and Claude 1 cloud rev-pares's MÉDIO on #2576: changed under it on every try, the product was
  // not written but noteProduct answered as if it had been, so lib/buyer-list.ts putOnList marked the checkout done
  // and no later run noted it. It must say the write is not confirmed, so the claim is let go and tried again.
  part("Changed under it on every try: never answered as noted, and noted once on the next try");
  let changes = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await pipeline(commands);
    if (commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === key) {
      changes += 1;
      await pipeline([["HSET", key, email, row(["early", `busy${changes}`])]]);
    }
    return answer;
  }) as typeof redis.pipeline;
  const busy = await noteProduct(list, email, "prod000888", "Recipe Box", store).then(() => "answered", (error: unknown) => (error instanceof Error ? error.name : "threw"));
  redis.pipeline = pipeline;
  is("the write is said not confirmed, never noted", busy, "UnknownReplyError");
  is("and the product is not on the row", parseContact(((await pipeline([["HGET", key, email]])) as string[])[0])!.ids.includes("prod000888"), false);
  is("the next try notes it", await noteProduct(list, email, "prod000888", "Recipe Box", store), true);
  is("once", parseContact(((await pipeline([["HGET", key, email]])) as string[])[0])!.ids.filter((id) => id === "prod000888"), ["prod000888"]);
  done();
}
void main();
