/**
 * Proof only (CX-123 rules 24 and 30), synthetic, no product file changed. docs/reviews/c5-store-read-unknown.md.
 *
 * lib/store.ts reads a store in two places that answer null both for "no store" and for a reply of unknown shape:
 *   storeForEmail (:1087-1100): `if (!Array.isArray(reply) || reply.length !== 1) return null;` and parseStore
 *     (:924-1080) answers null for a non-string, empty or unparseable record;
 *   storeForId (:1228-1234): `const [ref] = ...; if (typeof ref !== "string" || !ref) return null;`.
 * Every caller then acts on "there is no store". Five callers where that answer writes, deletes or drops something
 * that money or a person's data depends on are reproduced below. Each part runs a healthy control first; a check named
 * DEFECT passes while the defect is present and must be inverted once the reads are exact.
 */
import { claimHandle, storeFolder, storeForEmail, storeForId, storeRef } from "@/lib/store";
import { settleAllPayPal } from "@/lib/paypal-payouts";
import { HELD_INDEX, releaseRestarted } from "@/lib/closing-holds";
import { BATCH_KEY, DUE_KEY, WALK_KEY, eraseClosed } from "@/lib/closed-store-data";
import { removeStored } from "@/lib/plan-closing";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;
const original: Pipe = redis.pipeline.bind(redis);
const FAR = Date.now() + 60_000;

/** The unknown shapes a REST pipeline can hand back for one GET: no slot, another type, a record cut short. */
const SHAPES: [string, unknown[]][] = [
  ["no reply", []],
  ["a number", [7]],
  ["an object", [{ error: "ERR timeout" }]],
  ["text cut short", ["{\"handle\":\"ab"]],
];

/** The next single GET whose key starts with `prefix` answers `reply`; everything else reaches the in-memory Redis. */
function unknownOnce(prefix: string, reply: unknown[]) {
  let armed = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (armed && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith(prefix)) {
      armed = false;
      return reply;
    }
    return original(commands);
  }) as typeof redis.pipeline;
}
const heal = () => { redis.pipeline = original as typeof redis.pipeline; };

async function firstStore(email: string, handle: string) {
  const made = await claimHandle(email, handle, "Shop", "");
  if (!made.ok) throw new Error(`could not make ${handle}: ${made.reason}`);
  return made.store;
}

async function main() {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "down" }), { status: 500 })) as typeof fetch;

  part("0. The readers themselves: an unknown reply comes back as the same null as no store");
  redis.clear();
  const zero = await firstStore("zero@example.com", "zeroshop");
  for (const [label, reply] of SHAPES) {
    unknownOnce("nl:store:owner:", reply);
    const byEmail = await storeForEmail("zero@example.com");
    heal();
    unknownOnce("nl:store:id:", reply);
    const byId = await storeForId(zero.sid);
    heal();
    is(`DEFECT (${label}): storeForEmail and storeForId answer null, no throw, for a store that is there`, [byEmail, byId], [null, null]);
  }
  is("control: both find it on a healthy read", [(await storeForEmail("zero@example.com"))?.sid, (await storeForId(zero.sid))?.sid], [zero.sid, zero.sid]);

  part("1. ALTO (creator's store overwritten) - lib/store.ts:1731 claimHandle, called by app/api/store/claim/route.ts:64");
  redis.clear();
  const ana = await firstStore("ana@example.com", "anashop");
  is("control: a second claim on a healthy read is refused as already", await claimHandle("ana@example.com", "anaother", "Other", ""), { ok: false, reason: "already" });
  is("control: Ana's store is untouched", [(await storeForEmail("ana@example.com"))?.sid, (await storeForEmail("ana@example.com"))?.handle], [ana.sid, "anashop"]);
  for (const [label, reply] of SHAPES) {
    redis.clear();
    const first = await firstStore("ana@example.com", "anashop");
    unknownOnce("nl:store:owner:", reply);
    const second = await claimHandle("ana@example.com", `anaagain${label.length}`, "Again", "");
    heal();
    is(`DEFECT (${label}): the claim succeeds for an account that already has its first store`, second.ok, true);
    const now = await storeForEmail("ana@example.com");
    is(`DEFECT (${label}): the owner key now holds a fresh empty store, another id and handle`, [now?.sid === first.sid, now?.handle], [false, `anaagain${label.length}`]);
    is(`DEFECT (${label}): the original store's id no longer reaches any store`, await storeForId(first.sid), null);
  }

  part("2. ALTO (affiliates' money on its way never settled) - lib/paypal-payouts.ts:586-590 settleAllPayPal");
  const PP_STORES = "nl:pp:stores";
  redis.clear();
  const ghost = "f".repeat(32);
  await original([["SADD", PP_STORES, ghost]]);
  const bea = await firstStore("bea@example.com", "beashop");
  await original([["HSET", `nl:pp:open:${bea.statsId}`, "B-1", JSON.stringify({ at: 1, currency: "usd", lines: [{ a: "aff1", c: 2500 }] })], ["SADD", PP_STORES, bea.sid]]);
  await settleAllPayPal(FAR);
  const [kept] = await original([["SMEMBERS", PP_STORES]]);
  is("control: a store id with no store leaves the set; Bea's open batch keeps her in it", kept, [bea.sid]);
  for (const [label, reply] of SHAPES) {
    await original([["SADD", PP_STORES, bea.sid]]);
    unknownOnce("nl:store:id:", reply);
    await settleAllPayPal(FAR);
    heal();
    const [after, open] = await original([["SISMEMBER", PP_STORES, bea.sid], ["HGET", `nl:pp:open:${bea.statsId}`, "B-1"]]);
    is(`DEFECT (${label}): Bea is taken out of the daily settling set`, after, 0);
    is(`DEFECT (${label}): while her batch is still open, $25.00 to aff1 on its way`, typeof open === "string", true);
    is(`DEFECT (${label}): and her store is there`, (await storeForId(bea.sid))?.sid, bea.sid);
  }

  part("3. ALTO (members of a restarted store kept held) - lib/closing-holds.ts:422-426 releaseRestarted");
  redis.clear();
  const cai = await firstStore("cai@example.com", "caishop");
  const caiRef = storeRef(cai);
  const ENDED = Date.now() - 10 * 86_400_000;
  const stays = async () => false;
  await original([["ZADD", HELD_INDEX, ENDED, "nobody@example.com"], ["ZADD", HELD_INDEX, ENDED, caiRef]]);
  const healthy = await releaseRestarted(FAR, stays);
  is("control: no store is gone (right); Cai's restarted store is worked on, not gone", healthy.map((r) => [r.key, r.state === "gone"]).sort(), [[caiRef, false], ["nobody@example.com", true]].sort());
  is("control: Cai stays in line until her members are let go", (await original([["ZSCORE", HELD_INDEX, caiRef]]))[0] !== null, true);
  for (const [label, reply] of SHAPES) {
    await original([["ZADD", HELD_INDEX, ENDED, caiRef]]);
    unknownOnce("nl:store:owner:", reply);
    const run = await releaseRestarted(FAR, stays);
    heal();
    is(`DEFECT (${label}): Cai's store is called gone`, run.find((r) => r.key === caiRef)?.state, "gone");
    is(`DEFECT (${label}): and taken out of the held line, so her held members are never let go`, (await original([["ZSCORE", HELD_INDEX, caiRef]]))[0], null);
    is(`DEFECT (${label}): while the store is there`, (await storeForEmail(caiRef))?.sid, cai.sid);
  }

  part("4. MEDIO (closed store's data never erased, owner never told) - lib/closed-store-data.ts:592-598 eraseClosed");
  const finished: string[] = [];
  const finish = async (entry: { ref?: string }) => { finished.push(String(entry.ref ?? "?")); };
  redis.clear();
  const dan = await firstStore("dan@example.com", "danshop");
  const danRef = storeRef(dan);
  await original([["ZADD", DUE_KEY, Date.now() - 1000, danRef]]);
  const ok = await eraseClosed(FAR, finish as never);
  const [inBatch] = await original([["HEXISTS", BATCH_KEY, danRef]]);
  is("control: Dan's closed store is prepared into the erasure batch and the walk starts", [ok.stores, ok.started, inBatch === 1 || ok.finished === 1], [1, true, true]);
  for (const [label, reply] of SHAPES) {
    redis.clear();
    const d = await firstStore("dan@example.com", "danshop");
    const ref = storeRef(d);
    await original([["ZADD", DUE_KEY, Date.now() - 1000, ref]]);
    unknownOnce("nl:store:owner:", reply);
    const run = await eraseClosed(FAR, finish as never);
    heal();
    const [due, held, walk] = await original([["ZSCORE", DUE_KEY, ref], ["HEXISTS", BATCH_KEY, ref], ["HGET", WALK_KEY, "phase"]]);
    is(`DEFECT (${label}): nothing prepared, no walk started`, [run.stores, run.started], [0, false]);
    is(`DEFECT (${label}): yet it leaves the due line and is in no batch: its records are never erased`, [due, held, walk], [null, 0, null]);
    is(`DEFECT (${label}): while the store is there`, (await storeForEmail(ref))?.sid, d.sid);
  }

  part("5. ALTO (erasure certified done, files kept) - lib/plan-closing.ts:579-580 removeStored, read by closingDay (:904-909, :975-)");
  redis.clear();
  const eva = await firstStore("eva@example.com", "evashop");
  const evaRef = storeRef(eva);
  const folder = await storeFolder(evaRef);
  const removed: string[] = [];
  const hands = {
    list: async (prefix: string) => (prefix === `stores/${folder}/` ? [`stores/${folder}/guide.pdf`] : []),
    remove: async (paths: string[]) => { removed.push(...paths); },
  };
  await removeStored(evaRef, hands);
  is("control: the store's file is deleted on a healthy read", removed, [`stores/${folder}/guide.pdf`]);
  for (const [label, reply] of SHAPES) {
    removed.length = 0;
    unknownOnce("nl:store:owner:", reply);
    const answer = await removeStored(evaRef, hands);
    heal();
    is(`DEFECT (${label}): answered nothing to remove and clean, which closingDay saves as removed and emails`, answer, { files: 0, clean: true });
    is(`DEFECT (${label}): no file was deleted`, removed, []);
  }
  done();
}
main();
