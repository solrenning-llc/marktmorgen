/**
 * A purchase noted on a contact counted in the contacts' slot (Contact.r "c",
 * #2576) was written first and counted after, with noteData, which never says
 * whether it counted: a lost count left the row's growth stored and never
 * counted (Codex X6 re-check on 03ccf51044). Now the growth is counted before
 * the write and the row is written only once that count is confirmed; a count
 * that is not confirmed writes nothing and says so (UnknownReplyError), so the
 * order's listing is tried again. A row that changed under it gives back what
 * was counted for it. Real code with the stand-in Redis; synthetic data.
 */
import { leadsKey, noteProduct, parseContact } from "@/lib/contacts";
import { dataKey } from "@/lib/store-data";
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

type Commands = (string | number)[][];
const countsRoom = (commands: Commands) => commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:"));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("owner@countfirst.example", "countfirst", "Count First", "");
  await ensureStatsId("owner@countfirst.example");
  await ensureListId("owner@countfirst.example");
  const store = (await storeForEmail("owner@countfirst.example"))!;
  const list = store.listId!;
  const key = leadsKey(list);
  const email = "ines@example.com";
  const row = (tags: string[]) =>
    JSON.stringify({ agreed: true, agreedAt: "", firstAt: "2026-11-01T00:00:00.000Z", lastAt: "2026-11-01T00:00:00.000Z", titles: [], ids: [], source: "buyer", unsub: false, unsubAt: "", t: "", name: "", tags, importedAt: "", r: "c" });
  const pipeline = redis.pipeline.bind(redis);
  const slot = () => Number(redis.run(["HGET", String(dataKey(store)), "ct"]) ?? 0);
  const ids = async () => parseContact(((await pipeline([["HGET", key, email]])) as string[])[0])!.ids;
  await pipeline([["HSET", key, email, row(["vip"])]]);

  part("The count's reply is lost: the product is never stored uncounted");
  const start = slot();
  let lost = true;
  redis.pipeline = (async (commands: Commands) => {
    if (lost && countsRoom(commands)) {
      lost = false;
      // Lost before it ran: nothing counted, no reply.
      return [undefined];
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const outcome = await noteProduct(list, email, "prod000501", "Soup Book", store).then(
    (answer) => `answered ${answer}`,
    (error: unknown) => (error instanceof Error ? error.name : "threw"),
  );
  redis.pipeline = pipeline;
  const noted = (await ids()).includes("prod000501");
  is("a product on the row is always counted in the slot", !noted || slot() > start, true);
  is("not confirmed, it says so and writes nothing", [outcome, noted], ["UnknownReplyError", false]);

  part("The next try notes it once and counts it once");
  is("noted", await noteProduct(list, email, "prod000501", "Soup Book", store), true);
  const counted = slot() - start;
  is("on the row once", (await ids()).filter((id) => id === "prod000501"), ["prod000501"]);
  is("counted", counted > 0, true);

  part("A row that changed under it gives back what was counted for it");
  const beforeRace = slot();
  let once = true;
  redis.pipeline = (async (commands: Commands) => {
    const answer = await pipeline(commands);
    if (once && commands.length === 1 && commands[0][0] === "HGET" && commands[0][1] === key) {
      once = false;
      // A label added in between: the first try's write misses and its count goes back.
      const now = parseContact(((await pipeline([["HGET", key, email]])) as string[])[0])!;
      await pipeline([["HSET", key, email, JSON.stringify({ ...now, tags: ["vip", "late"] })]]);
    }
    return answer;
  }) as typeof redis.pipeline;
  is("noted on the second round", await noteProduct(list, email, "prod000502", "Stew Book", store), true);
  redis.pipeline = pipeline;
  const after = parseContact(((await pipeline([["HGET", key, email]])) as string[])[0])!;
  is("the label added stays", after.tags, ["vip", "late"]);
  is("the product is on the row", after.ids.includes("prod000502"), true);
  // The label was written outside noteProduct, uncounted; the slot holds one count of the product's growth (the same
  // size as the first one's, give or take the two commas of a second item in each list), not the lost round's too.
  const grown = slot() - beforeRace;
  is("counted once, not twice", Math.abs(grown - counted) <= 4, true);

  done();
}

void main();
