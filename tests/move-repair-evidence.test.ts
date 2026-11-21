/** Synthetic recovery evidence; no provider, mail or real account. */
import { createHash } from "node:crypto";
import { markBrokenMove, readBrokenMove } from "@/lib/auth";
import { clearBrokenMoveByHand, describeMove, repairMove } from "@/lib/move-repair";
import { claimHandle, createStore, moveAccount, settleDoubledStore } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const ownerKey = (email: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email}`).digest("hex").slice(0, 40)}`;
const A = "repair-a@example.test";
const B = "repair-b@example.test";
let external = 0;
globalThis.fetch = (async () => { external++; throw new Error("External request forbidden"); }) as typeof fetch;

async function doubled(extra = false): Promise<string> {
  redis.clear();
  await claimHandle(A, "repair-evidence", "Synthetic store", "");
  if (extra) await createStore(A, "repair-extra", "Extra", "");
  redis.pipeline = async (commands: Command[]) => {
    if (commands.some((c) => c[0] === "DEL" && c[1] === ownerKey(A))) throw new Error("Synthetic lost last step");
    return real(commands);
  };
  let copy = "";
  try { await moveAccount(A, B, async (print) => { copy = print; }).catch(() => null); }
  finally { redis.pipeline = real; }
  return copy;
}

async function main() {
  console.error = () => {};
  part("Unknown store reads never establish a recovery home");
  for (const operation of ["repair", "describe", "manual"] as const) {
    for (const shape of ["short", "long", "number", "json", "owner"] as const) {
      redis.clear();
      await claimHandle(A, "repair-left", "Left", "");
      await claimHandle(B, "repair-right", "Right", "");
      await markBrokenMove(A, B);
      redis.pipeline = async (commands: Command[]) => {
        const replies = await real(commands);
        if (commands.length !== 1 || commands[0][0] !== "GET" || commands[0][1] !== ownerKey(A)) return replies;
        if (shape === "short") return [];
        if (shape === "long") return [...replies, null];
        if (shape === "number") return [7];
        if (shape === "json") return ["{cut"];
        return [JSON.stringify({ ...JSON.parse(String(replies[0])), email: "other@example.test" })];
      };
      let outcome: unknown;
      try {
        outcome = operation === "repair" ? await repairMove(A) : operation === "describe" ? await describeMove(A) : await clearBrokenMoveByHand(A, A);
      } catch { outcome = "unknown"; }
      finally { redis.pipeline = real; }
      is(`${operation}/${shape}: stops on unknown evidence`, operation === "repair" ? outcome : outcome === "unknown", operation === "repair" ? false : true);
      is(`${operation}/${shape}: keeps recovery marker`, (await readBrokenMove(A))?.to, B);
    }
  }

  part("A malformed extra-store list cannot authorize deleting the copy");
  for (const shape of ["short", "number", "null", "bad-member"] as const) {
    const copy = await doubled();
    redis.pipeline = async (commands: Command[]) => {
      if (commands.length === 1 && commands[0][0] === "SMEMBERS" && String(commands[0][1]).startsWith("nl:account:stores:")) {
        return shape === "short" ? [] : shape === "number" ? [7] : shape === "null" ? [null] : [["invalid-store-id"]];
      }
      return real(commands);
    };
    const home = await settleDoubledStore(A, B, copy).catch(() => null);
    redis.pipeline = real;
    is(`${shape}: does not settle`, home, null);
    is(`${shape}: keeps losing copy`, typeof (await real([["GET", ownerKey(B)]]))[0], "string");
  }

  part("The stable store id must resolve to the selected home");
  for (const pointer of [null, B, "other@example.test", 7] as const) {
    const copy = await doubled();
    const [raw] = await real([["GET", ownerKey(A)]]);
    const sid = JSON.parse(String(raw)).sid;
    if (pointer === null) await real([["DEL", `nl:store:id:${sid}`]]);
    else await real([["SET", `nl:store:id:${sid}`, pointer]]);
    const home = await settleDoubledStore(A, B, copy).catch(() => null);
    is(`${pointer}: refuses mismatched id`, home, null);
    is(`${pointer}: preserves copy`, typeof (await real([["GET", ownerKey(B)]]))[0], "string");
  }
  part("A legacy copy must also retain its whole stored record");
  {
    await doubled();
    const raw = JSON.parse(String((await real([["GET", ownerKey(B)]]))[0]));
    await real([["SET", ownerKey(B), JSON.stringify({ ...raw, handKept: "synthetic note" })]]);
    is("legacy: keeps a field the parser drops", await settleDoubledStore(A, B).catch(() => null), null);
    is("legacy: preserves whole raw record", String((await real([["GET", ownerKey(B)]]))[0]).includes("synthetic note"), true);
  }
  for (const shape of ["long", "short"] as const) {
    const copy = await doubled();
    redis.pipeline = async (commands: Command[]) => {
      const replies = await real(commands);
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === ownerKey(B)) return shape === "long" ? [...replies, null] : [];
      return replies;
    };
    is(`${shape} losing-copy read: refuses`, await settleDoubledStore(A, B, copy).catch(() => null), null);
    redis.pipeline = real;
    is(`${shape} losing-copy read: preserves record`, typeof (await real([["GET", ownerKey(B)]]))[0], "string");
  }

  part("Late changes cannot pass the deletion guard");
  for (const change of ["id", "handle", "copy", "lock-a", "lock-b"] as const) {
    const copy = await doubled();
    let reached = false;
    redis.pipeline = async (commands: Command[]) => {
      for (const c of commands) {
        if (c[0] !== "EVAL" || !String(c[1]).startsWith("-- marktmorgen:move-copy-settle:v1")) continue;
        reached = true;
        const slot = change === "lock-a" ? 3 : change === "lock-b" ? 4 : change === "handle" ? 5 : change === "id" ? 6 : 7;
        await real([["SET", c[slot], "changed-since-read"]]);
      }
      return real(commands);
    };
    const home = await settleDoubledStore(A, B, copy).catch(() => null);
    redis.pipeline = real;
    is(`${change}: guard was reached`, reached, true);
    is(`${change}: refuses stale deletion`, home, null);
    is(`${change}: preserves losing record`, typeof (await real([["GET", ownerKey(B)]]))[0], "string");
  }

  part("Extra-store evidence and index transfer must finish before copy deletion");
  for (const failure of ["extra-read", "sadd-short", "sadd-refused"] as const) {
    const copy = await doubled(true);
    // Canonical untouched source copy, as a move rollback writes it.
    const kept = JSON.parse(String((await real([["GET", ownerKey(B)]]))[0]));
    await real([["SET", ownerKey(A), JSON.stringify({ ...kept, email: A })]]);
    const sid = JSON.parse(String((await real([["GET", ownerKey(A)]]))[0])).sid;
    // The move's handle and stable id reached the destination, but its final deletion did not.
    await real([["SET", "nl:store:handle:repair-evidence", B], ["SET", `nl:store:id:${sid}`, B]]);
    let failed = false;
    redis.pipeline = async (commands: Command[]) => {
      if (failure === "extra-read" && commands.length === 1 && commands[0][0] === "GET") {
        const reply = await real(commands);
        if (typeof reply[0] === "string" && reply[0].includes('"extra":true')) { failed = true; return []; }
        return reply;
      }
      if (failure !== "extra-read" && commands.some((c) => c[0] === "SADD" && String(c[1]).startsWith("nl:account:stores:"))) {
        failed = true;
        if (failure === "sadd-short") { await real(commands); return []; }
        // A non-atomic pipeline may keep executing DEL after a refused SADD.
        for (const c of commands) if (c[0] !== "SADD") await real([c]);
        // Match the transport: it throws after reading the pipeline's error, once later commands ran.
        throw new Error("Synthetic SADD refusal after the pipeline executed");
      }
      return real(commands);
    };
    const home = await settleDoubledStore(A, B, copy).catch(() => null);
    redis.pipeline = real;
    is(`${failure}: barrier reached`, failed, true);
    is(`${failure}: does not claim settled`, home, null);
    is(`${failure}: keeps losing copy`, typeof (await real([["GET", ownerKey(A)]]))[0], "string");
    const sets = await real([["SCAN", "0", "MATCH", "nl:account:stores:*", "COUNT", 100]]);
    const keys = (sets[0] as [string, string[]])[1];
    const members = await real(keys.map((key) => ["SMEMBERS", key]));
    is(`${failure}: extra store remains indexed`, members.some((ids) => Array.isArray(ids) && ids.length > 0), true);
    if (failure !== "extra-read") is(`${failure}: retry completes`, await settleDoubledStore(A, B, copy), B);
  }
  part("A stale membership index never transfers another owner's store");
  {
    const copy = await doubled(true);
    const sets = (await real([["SCAN", "0", "MATCH", "nl:account:stores:*", "COUNT", 100]]))[0] as [string, string[]];
    const ids = (await real([["SMEMBERS", sets[1][0]]]))[0] as string[];
    const key = ownerKey(`#${ids[0]}`);
    const record = JSON.parse(String((await real([["GET", key]]))[0]));
    await real([["SET", key, JSON.stringify({ ...record, email: "other@example.test" })]]);
    is("foreign owner: does not settle", await settleDoubledStore(A, B, copy).catch(() => null), null);
    is("foreign owner: does not overwrite ownership", JSON.parse(String((await real([["GET", key]]))[0])).email, "other@example.test");
    is("foreign owner: keeps copy", typeof (await real([["GET", ownerKey(B)]]))[0], "string");
  }
  const copy = await doubled();
  is("complete consistent evidence still settles", await settleDoubledStore(A, B, copy), A);
  is("only the losing copy is gone", (await real([["GET", ownerKey(B)]]))[0], null);
  is("no external request", external, 0);
  done();
}
void main();
