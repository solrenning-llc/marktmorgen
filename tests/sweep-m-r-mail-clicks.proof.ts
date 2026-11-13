/**
 * PROOF (MEDIUM, CX-123 rule 24), outside the CI run: lib/mail-clicks.ts reads
 * a person's contact and link use loosely, on the paths of a person's privacy
 * rights.
 *
 * - forgetClicksPerson (lib/person-erasure.ts): the contact's HGET is read with
 *   parseContact, which answers null for any reply that is not a JSON string,
 *   so an unknown reply reads as "no token": the key the person's links
 *   carried (nl:mail:mk:<key> -> their unsubscribe token, kept 400 days) is
 *   left behind while the erasure goes on as done. Its DEL count is
 *   `Number(gone) || 0`.
 * - clicksOf (lib/person-copy.ts): `Array.isArray(members) ? members : []`, so
 *   an unknown SMEMBERS reply gives the person a copy of their data that says
 *   they used no link, when it could not be read.
 *
 * Each check states the exact behaviour (unknown throws); the unknown ones fail
 * on main today. Synthetic data only.
 */
import { clicksOf, forgetClicksPerson, keyIndex, linkKeyOf, rememberLinkKeys } from "@/lib/mail-clicks";
import { leadsKey } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const LIST = "sweeplist00000000001";
const EMAIL = "reader@example.test";
const TOKEN = "a".repeat(40);

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);
  const answering = (command: string, reply: unknown) => {
    redis.pipeline = (async (commands: Commands) => {
      const replies = await pipe(commands);
      return replies.map((r, i) => (commands[i][0] === command ? reply : r));
    }) as typeof redis.pipeline;
  };
  const restore = () => { redis.pipeline = pipe as typeof redis.pipeline; };
  const setUp = async () => {
    redis.clear();
    await redisPipeline([["HSET", leadsKey(LIST), EMAIL, JSON.stringify({ agreed: true, t: TOKEN })]]);
    await rememberLinkKeys([TOKEN]);
  };
  const linkIndexKept = async () => (await redisPipeline([["EXISTS", keyIndex(linkKeyOf(TOKEN))]]))[0] === 1;

  part("Control: the contact read as it is kept");
  await setUp();
  is("the token is one the module accepts (the link index was written)", await linkIndexKept(), true);
  await forgetClicksPerson(LIST, EMAIL);
  is("erased: the key their links carried is gone", await linkIndexKept(), false);

  for (const [name, reply] of [["an error string", "ERR"], ["an object", { agreed: true, t: TOKEN }], ["a number", 1]] as const) {
    part(`The contact's HGET answers ${name}`);
    await setUp();
    answering("HGET", reply);
    const run = await forgetClicksPerson(LIST, EMAIL).then(() => "done", () => "unknown");
    restore();
    is("the erasure is not said as done while the link key may remain", run, "unknown");
    // A refused erasure cannot also remove the key in the same pass (the token is unknown);
    // the key stays until the erasure is tried again, and the refusal above says so.
    is("and the key their links carried stays until the erasure is tried again", await linkIndexKept(), true);
  }

  part("The copy of a person's data: an SMEMBERS that is not a list");
  redis.clear();
  await redisPipeline([["SADD", `nl:mail:clk:${LIST}:x`, "s-0000000000000000-0000000000000000"]]);
  answering("SMEMBERS", "ERR");
  const copy = await clicksOf(LIST, EMAIL).then((v) => JSON.stringify(v), () => "unknown");
  restore();
  is("unknown, never 'used no link'", copy, "unknown");
  done();
}

void main();
