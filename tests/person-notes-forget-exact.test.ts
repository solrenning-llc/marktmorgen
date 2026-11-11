/**
 * lib/buyer-profile.ts forgetPersonNotes (a store's deletion) read the index of the people with notes (SMEMBERS) with
 * `Array.isArray(raw) ? … : []`: a reply in any other shape was taken for "nobody", and the index was then deleted,
 * so every person's notes stayed behind, unreachable, until they lapsed (Claude 4 nuvem R's MEDIUM for #2287; rule 24).
 * Now only an exact list of texts is read; anything else throws UnknownReplyError and nothing is deleted, so the next
 * try still finds every note. Synthetic Redis only.
 */
import { forgetPersonNotes } from "@/lib/buyer-profile";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const STATS = "statsforgetnotes1";
const WHO = `nl:person:${STATS}:who`;
const PERSON = "a".repeat(32);
const NOTES = `nl:person:${STATS}:n:${PERSON}`;

async function main(): Promise<void> {
  const real = redis.pipeline.bind(redis);
  for (const [label, reply] of [
    ["no reply", []],
    ["an error object", [{ error: "ERR synthetic" }]],
    ["a number", [2]],
    ["a list with a non-text", [[PERSON, 7]]],
  ] as const) {
    part(label);
    redis.clear();
    await real([["SADD", WHO, PERSON], ["SET", NOTES, "a note"]]);
    const deletes: Command[] = [];
    redis.pipeline = (async (commands: Command[]) => {
      if (commands.length === 1 && commands[0][0] === "SMEMBERS" && commands[0][1] === WHO) return reply;
      deletes.push(...commands.filter((c) => c[0] === "DEL"));
      return real(commands);
    }) as never;
    let threw = false;
    try {
      await forgetPersonNotes(STATS);
    } catch {
      threw = true;
    }
    redis.pipeline = real as never;
    is("the deletion stops as unknown", threw, true);
    is("nothing is deleted", deletes.length, 0);
    is("the index and the note are still there for the next try", [(await real([["SMEMBERS", WHO]]))[0], (await real([["GET", NOTES]]))[0]], [[PERSON], "a note"]);
  }
  part("control: an exact list deletes every note and the index");
  redis.clear();
  await real([["SADD", WHO, PERSON], ["SET", NOTES, "a note"]]);
  await forgetPersonNotes(STATS);
  is("the note and the index are gone", [(await real([["EXISTS", NOTES]]))[0], (await real([["EXISTS", WHO]]))[0]], [0, 0]);
  done();
}

void main();
