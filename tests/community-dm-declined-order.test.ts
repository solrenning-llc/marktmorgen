/**
 * Past MAX_DECLINED refusals, the person just declined is never the one let
 * go, and the bound holds on any reply (consent; CX-123 rule 24).
 *
 * lib/community-dm.ts decline() kept who a person declined in a plain set
 * and, past MAX_DECLINED, took one member away with SPOP, whose comment said
 * "the oldest": SPOP takes a member at random, so it could take the person
 * declined a moment before (about one time in 501), who could then write
 * again. And it read the set's size with Number(SCARD): an unknown reply
 * read as NaN, nothing was cut, and the set grew past its bound unseen.
 *
 * Each refusal now goes into a sorted set scored by when it was made; the
 * cut keeps the newest and never touches the one just written, and needs no
 * size read at all. Refusals written before this change, in the plain set,
 * are still read by every check, can still be lifted, are converted on the
 * person's next refusal without losing one, and are erased with the person.
 *
 * Synthetic only: the in-memory Redis stand-in. Its SPOP takes the first
 * member; real Redis may take any, so here it takes the one added last, an
 * answer Redis may give.
 */
import { decline, declinedBy, forgetDmPerson, MAX_DECLINED, pairOf, parseDmSetting, send, unblock } from "@/lib/community-dm";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

const stub = redis.pipeline.bind(redis);
/** The member each declined set was last given, so SPOP can take that one. */
const lastAdded = new Map<string, string>();
/** Every command that reached the store. */
const seen: Command[] = [];
const run = async (commands: Command[]): Promise<unknown[]> => {
  const out: unknown[] = [];
  for (const command of commands) {
    const key = String(command[1] ?? "");
    if (command[0] === "SADD" && key.includes(":dm:x")) lastAdded.set(key, String(command[command.length - 1]));
    if (command[0] === "SPOP" && key.includes(":dm:x") && lastAdded.has(key)) {
      const member = lastAdded.get(key)!;
      const [gone] = await stub([["SREM", key, member]]);
      if (gone === 1) {
        out.push(member);
        continue;
      }
    }
    out.push((await stub([command]))[0]);
  }
  return out;
};
/** The reply `bad` stands in for every command `match` picks; the command itself still runs. */
let swap: { match: (command: Command) => boolean; bad: unknown } | null = null;
redis.pipeline = (async (commands: Command[]) => {
  seen.push(...commands);
  const replies = await run(commands);
  const rule = swap;
  return rule ? replies.map((reply, i) => (rule.match(commands[i]) ? rule.bad : reply)) : replies;
}) as typeof redis.pipeline;

/** A clock that moves a second for each refusal, so "oldest" means something. */
let clock = Date.now();
Date.now = () => clock;

const UNKNOWN: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["the text \"1\"", "1"],
  ["NaN", Number.NaN],
  ["a list [1]", [1]],
  ["an object", { result: 1 }],
  ["minus one", -1],
  ["one and a half", 1.5],
];

const verbIs = (verb: string, part: string) => (command: Command) => command[0] === verb && String(command[1]).includes(part);

async function outcome<T>(call: () => Promise<T>): Promise<T | string> {
  const quiet = console.error;
  console.error = () => {};
  try {
    return await call();
  } catch (error) {
    return `threw ${error instanceof Error ? error.name : "something"}`;
  } finally {
    console.error = quiet;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  const open = parseDmSetting({ on: true, between: true, ask: true });
  let next = 0;
  const fresh = () => (0xa00000000000 + (next += 1)).toString(16);
  /** `who` asks `whom`, and `whom` says no. */
  const asksAndIsDeclined = async (id: string, who: string, whom: string) => {
    const asked = await send(id, open, who, whom, "Hello", ROOM);
    const said = await decline(id, whom, pairOf(who, whom), ROOM);
    clock += 1000;
    return asked.ok && asked.asked && said;
  };
  const isDeclined = async (id: string, who: string, whom: string) => {
    const got = await send(id, open, who, whom, "Hello again", ROOM);
    return !got.ok && got.reason === "declined";
  };

  part("Past MAX_DECLINED: the oldest refusal is let go, never the one just made");
  const ID = "cmdeclinedorder";
  const BIA = "b2b2b2b2b2b2";
  const people: string[] = [];
  {
    let all = true;
    for (let i = 0; i <= MAX_DECLINED; i += 1) {
      const who = fresh();
      people.push(who);
      all = (await asksAndIsDeclined(ID, who, BIA)) && all;
    }
    is(`control: ${MAX_DECLINED + 1} strangers asked and were declined`, all, true);
    const last = people[people.length - 1];
    is("the person declined last cannot write again", await isDeclined(ID, last, BIA), true);
    is("nor can the second", await isDeclined(ID, people[1], BIA), true);
    const kept = await declinedBy(ID, BIA);
    is("the list holds exactly MAX_DECLINED", kept.length, MAX_DECLINED);
    is("the first, the oldest, is the one let go", kept.includes(people[0]), false);
    is("no member is ever taken at random (SPOP)", seen.some((c) => c[0] === "SPOP" && String(c[1]).includes(":dm:x")), false);
  }

  part("Any unknown reply in deciding the bound: the bound holds, or decline says not done and a retry finishes it");
  {
    // The old plain set's move is one script (lib/community-dm.ts DECLINED_MOVE), picked by its name.
    const moveScript = (command: Command) => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:dm-declined-move:");
    for (const verb of ["SCARD", "ZCARD", "SMEMBERS", "ZADD", "ZREMRANGEBYRANK", "SREM", "ZRANGEBYSCORE", "EVAL"]) {
      for (const [label, bad] of UNKNOWN) {
        const who = fresh();
        is(`control (${verb} ${label}): the stranger asks`, (await send(ID, open, who, BIA, "Hi", ROOM)).ok, true);
        swap = { match: verb === "EVAL" ? moveScript : verbIs(verb, ":dm:x"), bad };
        const first = await outcome(() => decline(ID, BIA, pairOf(who, BIA), ROOM));
        swap = null;
        const retried = first === true ? true : await outcome(() => decline(ID, BIA, pairOf(who, BIA), ROOM));
        clock += 1000;
        is(
          `${verb} answered ${label}: done or said not done, then done; the bound holds and they are declined`,
          [first === true || first === "threw UnknownReplyError", retried, (await declinedBy(ID, BIA)).length <= MAX_DECLINED, await isDeclined(ID, who, BIA)],
          [true, true, true, true],
        );
      }
    }
  }

  part("Refusals kept the old way (a plain set) are read, lifted, converted and erased");
  {
    const ID2 = "cmdeclinedlegacy";
    const CARLA = "c3c3c3c3c3c3";
    const legacy = `nl:cm:${ID2}:dm:x:${CARLA}`;
    const old = [fresh(), fresh(), fresh()];
    await stub([["SADD", legacy, ...old]]);
    is("an old refusal still refuses", await isDeclined(ID2, old[0], CARLA), true);
    is("every old refusal is listed", (await declinedBy(ID2, CARLA)).sort(), [...old].sort());
    await unblock(ID2, CARLA, old[2], ROOM);
    is("an old refusal can be lifted: they may write again", (await send(ID2, open, old[2], CARLA, "Hi", ROOM)).ok, true);
    const newcomer = fresh();
    is("control: a new refusal", await asksAndIsDeclined(ID2, newcomer, CARLA), true);
    is("the new refusal holds", await isDeclined(ID2, newcomer, CARLA), true);
    is("the old ones still hold after the conversion", [await isDeclined(ID2, old[0], CARLA), await isDeclined(ID2, old[1], CARLA)], [true, true]);
    // The stand-in makes an empty set when one is read; Redis keeps none, so "holds nothing" is the check.
    is("the old plain set holds nothing: converted", (await stub([["SCARD", legacy]]))[0], 0);
    is("the list is the old ones and the new one", (await declinedBy(ID2, CARLA)).sort(), [old[0], old[1], newcomer].sort());
    await stub([["SADD", legacy, fresh()]]);
    await forgetDmPerson(ID2, CARLA);
    // Looked for before anything reads them again (the stand-in makes an empty set on a read).
    const [, keys] = (await stub([["SCAN", "0", "MATCH", `nl:cm:${ID2}:dm:x*`, "COUNT", 1000]]))[0] as [string, string[]];
    is("erased with the person: no declined key of hers is left, old or new", keys.filter((k) => k.endsWith(CARLA)), []);
    is("and nothing declined is listed", await declinedBy(ID2, CARLA), []);
  }

  part("Old refusals at the bound: one of them is let go, never the new one");
  {
    const ID3 = "cmdeclinedfull";
    const DANI = "d4d4d4d4d4d4";
    const old = Array.from({ length: MAX_DECLINED }, () => fresh());
    await stub([["SADD", `nl:cm:${ID3}:dm:x:${DANI}`, ...old]]);
    const newcomer = fresh();
    is("control: a new refusal past the bound", await asksAndIsDeclined(ID3, newcomer, DANI), true);
    is("the new refusal holds", await isDeclined(ID3, newcomer, DANI), true);
    const kept = await declinedBy(ID3, DANI);
    is("the list holds exactly MAX_DECLINED", kept.length, MAX_DECLINED);
    is("exactly one old refusal was let go", old.filter((who) => !kept.includes(who)).length, 1);
  }

  part("send(): whether the sender was declined is read exactly in both places a refusal is kept");
  {
    const ID4 = "cmdeclinedsend";
    const EVA = "e5e5e5e5e5e5";
    const who = fresh();
    is("control: Eva declines a stranger", await asksAndIsDeclined(ID4, who, EVA), true);
    // A score is a number or its text; anything else, or no reply, is unknown.
    const NOT_A_SCORE: [string, unknown][] = [["undefined", undefined], ["NaN", Number.NaN], ["an empty text", ""], ["a word", "yes"], ["true", true], ["a list [1]", [1]], ["an object", { score: 1 }]];
    for (const [label, bad] of NOT_A_SCORE) {
      swap = { match: verbIs("ZSCORE", ":dm:xo:"), bad };
      const got = await outcome(() => send(ID4, open, who, EVA, `hello (${label})`, ROOM));
      swap = null;
      is(`the refusal's score answered ${label}: refused as unknown`, got, "threw UnknownReplyError");
    }
    for (const [label, bad] of [["null", null], ["two", 2], ["the text \"1\"", "1"], ["an object", { result: 1 }]] as [string, unknown][]) {
      swap = { match: verbIs("SISMEMBER", ":dm:x:"), bad };
      const got = await outcome(() => send(ID4, open, fresh(), EVA, `hello (${label})`, ROOM));
      swap = null;
      is(`the old refusal answered ${label}: refused as unknown`, got, "threw UnknownReplyError");
    }
    is("control: still declined on exact replies", await isDeclined(ID4, who, EVA), true);
  }

  done();
}

main();
