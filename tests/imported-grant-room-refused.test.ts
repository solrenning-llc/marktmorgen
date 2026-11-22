/**
 * A grant taken from the store's data room (an import, the API's gift) gives
 * its room back when the write is refused for certain: HSETNX answering 0,
 * the address already holds that product (Claude 5's note on #2576). Before,
 * every refused grant stayed counted, so giving the same product twice, or
 * an import run again, filled the room with nothing. A reply that is not
 * exactly 0 or 1 keeps what was taken, as the room must never be counted
 * below what is held. Synthetic store; no outside request.
 */
import { grantImported, grantImportedOutcomes, importedKey } from "@/lib/imported-purchases";
import { dataUsed } from "@/lib/store-data";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

const OWNER = "grant-room@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "grantroom", "Synthetic grants", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_GrantRoom", subscriptionId: "sub_GrantRoom", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Guide", "A guide.", "29", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const grant = [{ email: "dana@example.com", productId: made.product.id, items: null }];
  const used = async () => (await dataUsed(store))?.used ?? -1;

  part("Given once, then again");
  const empty = await used();
  is("the first gift is new", await grantImported(store.statsId!, "api:key1", grant, 1_800_000_000, "", store), [true]);
  const once = await used();
  is("and takes room", once > empty, true);
  is("the same gift again is not new", await grantImported(store.statsId!, "api:key1", grant, 1_800_000_000, "", store), [false]);
  is("and leaves the room as it was", await used(), once);

  part("A refusal that is not known for certain");
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await pipe(commands);
    return commands.every((c) => c[0] === "HSETNX") ? replies.map(() => undefined) : replies;
  }) as typeof redis.pipeline;
  const unknown = await grantImported(store.statsId!, "api:key1", grant, 1_800_000_000, "", store);
  redis.pipeline = pipe;
  is("an unknown answer is not new", unknown, [false]);
  const kept = await used();
  is("and keeps what it took", kept > once, true);

  part("Each grant's outcome, read exactly");
  const other = [{ email: "hal@example.com", productId: grant[0].productId, items: null }];
  is("written", await grantImportedOutcomes(store.statsId!, "api:key1", other, 1_800_000_000, "", store), ["taken"]);
  const taken = await used();
  is("already held", await grantImportedOutcomes(store.statsId!, "api:key1", other, 1_800_000_000, "", store), ["exists"]);
  is("already held gives its room back", await used(), taken);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await pipe(commands);
    return commands.every((c) => c[0] === "HSETNX") ? replies.map(() => "1") : replies;
  }) as typeof redis.pipeline;
  const odd = await grantImportedOutcomes(store.statsId!, "api:key1", other, 1_800_000_000, "", store);
  redis.pipeline = pipe;
  is("an answer in another shape is unknown, never taken", odd, ["unknown"]);

  part("A reply whose slot runs code (Codex G on #2576)");
  // The write really happens; only the reply's envelope is replaced. Each
  // reply is read once, from its own data slots, before any room is given
  // back: a getter, a Proxy or an inherited slot is unknown, so the grant
  // that was written keeps its room and is never said to be new.
  let runs = 0;
  const envelopes: [string, () => unknown[]][] = [
    ["a getter answering 0 then 1", () => {
      const answer: unknown[] = Array(1);
      Object.defineProperty(answer, "0", { get: () => (++runs === 1 ? 0 : 1) });
      return answer;
    }],
    ["a Proxy answering 0 then 1", () => {
      let seen = 0;
      return new Proxy([0], {
        get: (target, key, receiver) => {
          if (key === "0") {
            runs++;
            return ++seen === 1 ? 0 : 1;
          }
          return Reflect.get(target, key, receiver);
        },
      });
    }],
    ["an inherited slot", () => {
      const answer: unknown[] = Array(1);
      Object.setPrototypeOf(answer, Object.assign(Object.create(Array.prototype), { 0: 0 }));
      return answer;
    }],
  ];
  for (const [i, [label, envelope]] of envelopes.entries()) {
    runs = 0;
    const email = `envelope${i}@example.com`;
    const before = await used();
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipe(commands);
      return commands.length === 1 && commands[0][0] === "HSETNX" && commands[0][1] === importedKey(store.statsId!, email) ? envelope() : replies;
    }) as typeof redis.pipeline;
    const outcome = await grantImportedOutcomes(store.statsId!, "api:key1", [{ email, productId: grant[0].productId, items: null }], 1_800_000_000, "", store);
    redis.pipeline = pipe;
    const [held] = await pipe([["HEXISTS", importedKey(store.statsId!, email), grant[0].productId]]);
    is(`${label}: the grant was written`, held, 1);
    is(`${label}: its outcome is unknown`, outcome, ["unknown"]);
    is(`${label}: and it keeps its room`, (await used()) > before, true);
    is(`${label}: no code of the reply runs`, runs, 0);
  }
  done();
}

void main();
