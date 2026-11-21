/**
 * The told list's mark for a buyer the cap did not cover is our own (CX-123 rule 24; Claude 4).
 *
 * tellBuyers counts such a buyer once, by HSETNX of a mark. The mark was the constant "x", so when the HSETNX's
 * reply was lost on a write that landed, a read-back could not tell our write from another run's, and the buyer was
 * not counted: fewer buyers said as "could not be told" than there were. Now each write is its own mark,
 * "x:<16 hex>": after a reply out of shape the field is read back once (HGET), and only our own mark is counted.
 * A read-back out of shape throws UnknownReplyError (the closing job holds and tries again). Every reader of the told
 * list (toldOf, tellBuyers, tellRefundShort, tellStaysOpen) takes the old "x" and the new form alike as "not told".
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), with replies swapped per command.
 */
import { startClosingCredit } from "@/lib/closing-credit";
import { workKey } from "@/lib/closing-holds";
import { tellBuyers, tellRefundShort, tellStaysOpen, toldKey, toldOf } from "@/lib/closing-buyers";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** What a matching pipeline answers instead: "run" runs it and then answers `reply`; "skip" answers `reply` without running it. */
type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown[]; run: boolean; before?: () => Promise<void> };
let rules: Rule[] = [];
const sent: (string | number)[][][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(commands);
  const rule = rules.find((r) => r.when(commands));
  if (rule) {
    if (rule.before) await rule.before();
    if (rule.run) await pipeline(commands);
    return rule.reply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const first = (name: string) => (commands: (string | number)[][]) => commands[0]?.[0] === name && String(commands[0]?.[1]).startsWith("nl:closing:told:");
const sentSince = (from: number, name: string) => sent.slice(from).some((commands) => commands.some((c) => c[0] === name && String(c[1]).startsWith("nl:closing:told:")));

async function outcome<T>(run: () => Promise<T>): Promise<T | "rejected"> {
  try {
    return await run();
  } catch {
    return "rejected";
  }
}

const OWN_MARK = /^x:[0-9a-f]{16}$/;
const BUYER = "member@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  const owner = "told-own-mark@example.com";
  await claimHandle(owner, "toldownmark", "Told Own Mark", "");
  const shop = await storeForEmail(owner);
  if (!shop) throw new Error("the test store was not made");
  const folder = await storeFolder(storeRef(shop));
  const told = toldKey(folder);
  const E = Date.UTC(2026, 10, 1);
  const day = E + 30 * 86_400_000;
  const field = async (name: string) => (await pipeline([["HGET", told, name]]))[0];

  /** One member with an address, no credit left: the cap does not cover them, so they are marked untold. */
  async function fresh(): Promise<void> {
    rules = [];
    await pipeline([["DEL", told, workKey(folder)]]);
    await pipeline([["HSET", workKey(folder), "m:sub_ownmark", BUYER]]);
    await startClosingCredit(folder, 0);
  }
  const tell = () => outcome(() => tellBuyers(shop!, E, day, "", Date.now() + 60_000));

  part("tellBuyers: the untold mark is our own, and a lost reply on a write that landed is still counted");
  await fresh();
  {
    const got = await tell();
    is("healthy HSETNX: counted once", got !== "rejected" && got.untold, 1);
    is("healthy HSETNX: the mark is our own", OWN_MARK.test(String(await field(BUYER))), true);
    const again = await tell();
    is("healthy HSETNX: a second run does not count them again", again !== "rejected" && again.untold, 0);
  }

  await fresh();
  rules = [{ when: first("HSETNX"), reply: ["?"], run: true }];
  {
    const from = sent.length;
    const got = await tell();
    is("HSETNX reply lost, the write landed: read back and counted", got !== "rejected" && got.untold, 1);
    is("HSETNX reply lost: read back once with HGET", sentSince(from, "HGET"), true);
    rules = [];
    is("HSETNX reply lost: the mark written is our own", OWN_MARK.test(String(await field(BUYER))), true);
  }

  await fresh();
  rules = [{ when: first("HSETNX"), reply: [], run: false }];
  {
    const got = await tell();
    is("HSETNX reply lost, nothing written: not counted", got !== "rejected" && got.untold, 0);
    rules = [];
    is("HSETNX reply lost, nothing written: still absent, so tried again next run", await field(BUYER), null);
  }

  await fresh();
  // Another run wrote its own mark just before ours: ours did not land, and theirs is not ours to count.
  rules = [{ when: first("HSETNX"), reply: [null], run: true, before: async () => void (await pipeline([["HSET", told, BUYER, "x:0123456789abcdef"]])) }];
  {
    const got = await tell();
    is("HSETNX reply lost, another run's mark there: not counted by us", got !== "rejected" && got.untold, 0);
  }

  await fresh();
  rules = [{ when: first("HSETNX"), reply: ["?"], run: true }, { when: first("HGET"), reply: [7], run: false }];
  is("HSETNX reply lost and the read-back out of shape: unknown, the run stops", await tell(), "rejected");

  // Text the list never holds (neither a mark nor a told time) is unknown too, never "another run's mark" (P-3009).
  for (const bad of ["x:zz", "x:0123456789ABCDEF", "x:", "xx", "told", "-5", ""]) {
    await fresh();
    rules = [{ when: first("HSETNX"), reply: ["?"], run: false }, { when: first("HGET"), reply: [bad], run: false }];
    is(`HSETNX reply lost and the read-back ${JSON.stringify(bad)}: unknown, the run stops`, await tell(), "rejected");
  }
  // What the list does hold, when it is not ours: not counted by us, and the run goes on.
  for (const known of ["x", "x:fedcba9876543210", String(E)]) {
    await fresh();
    rules = [{ when: first("HSETNX"), reply: ["?"], run: false }, { when: first("HGET"), reply: [known], run: false }];
    const got = await tell();
    is(`HSETNX reply lost and the read-back ${known} (not ours): not counted, the run goes on`, got !== "rejected" && got.untold, 0);
  }

  await fresh();
  rules = [{ when: first("HSETNX"), reply: [0], run: true }];
  {
    const from = sent.length;
    const got = await tell();
    is("HSETNX answers 0 (already marked): not counted, nothing read back", got !== "rejected" && got.untold === 0 && !sentSince(from, "HGET"), true);
  }
  rules = [];

  part("readers: the old mark and the new one are both \"not told\"");
  for (const mark of ["x", "x:0123456789abcdef"]) {
    await pipeline([["DEL", told]]);
    await pipeline([["HSET", told, BUYER, mark]]);
    is(`toldOf, mark ${mark}: on the list, not told`, await outcome(() => toldOf(shop, BUYER)), { toldAt: 0 });
    await startClosingCredit(folder, 0);
    const short = await outcome(() => tellRefundShort(shop, [{ email: BUYER, amount: 500, cur: "usd" }], E));
    is(`tellRefundShort, mark ${mark}: not paid for, so the empty credit counts them untold`, short !== "rejected" && short.untold, 1);
    await pipeline([["HSET", workKey(folder), "m:sub_ownmark", BUYER]]);
    await startClosingCredit(folder, 10);
    const from = sent.length;
    await tell();
    is(`tellBuyers, mark ${mark}: not written to again`, sent.slice(from).some((c) => c.some((cmd) => cmd[0] === "DECRBY" && String(cmd[1]).startsWith("nl:closing:credit:"))), false);
  }
  for (const mark of ["x:zz", "x:0123456789ABCDEF", "x:", "xx"]) {
    await pipeline([["DEL", told]]);
    await pipeline([["HSET", told, BUYER, mark]]);
    is(`toldOf, a mark out of shape (${mark}): unknown`, await outcome(() => toldOf(shop, BUYER)), "rejected");
  }

  part("tellStaysOpen: untold marks, old and new, are let go, and nobody is written to");
  await pipeline([["DEL", told]]);
  await pipeline([["HSET", told, "old@example.com", "x", "new@example.com", "x:0123456789abcdef", "#sub_nomail", "x:fedcba9876543210"]]);
  is("tellStaysOpen: only untold marks: done, nothing to send", await outcome(() => tellStaysOpen(shop, Date.now() + 60_000)), true);
  is("tellStaysOpen: the told list is let go", (await pipeline([["HLEN", told]]))[0], 0);

  part("tellStaysOpen: an HSCAN reply out of shape holds, never \"all of it went\" (Claude 6 on #3009)");
  await pipeline([["DEL", told]]);
  await pipeline([["HSET", told, "toldbuyer@example.com", String(E)]]);
  for (const [label, reply] of [
    ["no reply", []],
    ["null", [null]],
    ["an object", [{}]],
    ["a list that is not a page", [["0", "nope"]]],
    ["an odd page", [["0", ["toldbuyer@example.com"]]]],
    ["a cursor that is not text", [[0, ["toldbuyer@example.com", String(E)]]]],
    ["a field that is not text", [["0", [5, String(E)]]]],
    ["a short reply", [["0"]]],
  ] as [string, unknown[]][]) {
    rules = [{ when: first("HSCAN"), reply, run: false }];
    is(`HSCAN ${label}: held, not done`, await outcome(() => tellStaysOpen(shop, Date.now() + 60_000)), false);
    rules = [];
    is(`HSCAN ${label}: the told buyer is still on the list`, await field("toldbuyer@example.com"), String(E));
  }
  await pipeline([["DEL", told]]);
  is("confirmed empty list: done", await outcome(() => tellStaysOpen(shop, Date.now() + 60_000)), true);

  part("a member with no address: the same own mark");
  await pipeline([["DEL", told, workKey(folder)]]);
  await pipeline([["HSET", workKey(folder), "m:sub_noaddr", "-"]]);
  await startClosingCredit(folder, 0);
  rules = [{ when: first("HSETNX"), reply: ["?"], run: true }];
  {
    const got = await tell();
    is("no address, HSETNX reply lost on a write that landed: counted", got !== "rejected" && got.untold, 1);
    rules = [];
    is("no address: the mark is our own", OWN_MARK.test(String(await field("#sub_noaddr"))), true);
  }
  done();
}
void main();
