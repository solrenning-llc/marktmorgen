/**
 * forgetAssistReminderPerson (lib/assistant-reminder.ts), the Store assistant
 * checkout reminder's erasure part, the sibling of the welcome reminder fixed
 * on #2998:
 *
 *   Race: it read the address's note of checkouts (SMEMBERS) and deleted the
 *   note and the yeses in a second round trip. A yes written between the two
 *   (keepAssistReminder: SET the yes, SADD its checkout to the note) lost its
 *   note with the DEL while the yes itself, holding the address, stayed for
 *   three days where no later erasure could find it. After an erasure, every
 *   yes is either gone or still noted under its address.
 *
 *   Rule 24: the replies were read loosely (`Number(gone) || 0`, a list that
 *   was not one taken as empty), so an unknown reply turned into "0 removed"
 *   and the erasure said done. Each reply is now read in its exact shape and
 *   anything else rejects (UnknownReplyError), so the part is said as not
 *   finished.
 *
 *   Size (7 November 2026): the deletion was one DEL of unpack(KEYS), which
 *   real Redis refuses past about 8,000 keys ("too many results to unpack"),
 *   so a person with that many checkouts noted could never be erased. It now
 *   deletes in blocks. Checked on a real redis-server when
 *   ASSIST_REMIND_REDIS_SERVER names one (a disposable loopback process only).
 *
 *   Rounds: a note that changes in every one of the rounds is never deleted
 *   blind: the part throws (not finished) and every yes stays noted.
 *
 * Synthetic data only: the in-memory Redis stand-in, or a disposable local
 * redis-server.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { FORGET_IF_SAME, forgetAssistReminderPerson } from "@/lib/assistant-reminder";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const STATS = "5b1f0c3e2a7d4e9f8c6b5a4d3e2f1a0b";
const EMAIL = "person@example.com";
const KEEP = 3 * 86_400;
const who = `nl:assist:remindwho:${STATS}:${createHash("sha256").update(`nimbus-assist-remind:${STATS}:${EMAIL}`).digest("hex").slice(0, 32)}`;
const session = (c: string) => `cs_test_${c.repeat(24)}`;
const yes = (s: string) => `nl:assist:remind:${s}`;
const consent = (s: string) => JSON.stringify({ s: STATS, e: EMAIL, t: "Email me a reminder if I don't finish this order", v: "1", l: "en", at: 1_790_000_000_000 + s.length });

/** As keepAssistReminder writes one yes (lib/assistant-reminder.ts), without its queue line. */
function keepCommands(s: string): (string | number)[][] {
  return [
    ["SET", yes(s), consent(s), "EX", KEEP],
    ["SADD", who, s],
    ["EXPIRE", who, KEEP],
  ];
}

let between: string | null = null;
/** A new yes written after every read of the note, for the rounds test. */
let always = 0;
let bad: { commands: string[]; reply: () => unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bad && commands.some((command) => bad!.commands.includes(String(command[0])))) return commands.map(() => bad!.reply());
  const replies = await pipeline(commands);
  // The race: a yes written right after the erasure read the note, before anything was deleted.
  if (between && commands.some((command) => command[0] === "SMEMBERS" && command[1] === who)) {
    const s = between;
    between = null;
    await pipeline(keepCommands(s));
  }
  if (always > 0 && commands.some((command) => command[0] === "SMEMBERS" && command[1] === who)) {
    always += 1;
    await pipeline(keepCommands(session(String.fromCharCode(100 + always))));
  }
  return replies;
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

async function seed(...sessions: string[]): Promise<void> {
  redis.clear();
  for (const s of sessions) await redisPipeline(keepCommands(s));
}

async function exists(key: string): Promise<number> {
  const [n] = await redisPipeline([["EXISTS", key]]);
  return Number(n);
}

async function scard(): Promise<number> {
  const [n] = await redisPipeline([["SCARD", who]]);
  return Number(n);
}

async function noted(s: string): Promise<number> {
  const [n] = await redisPipeline([["SISMEMBER", who, s]]);
  return Number(n);
}


/** A RESP command to a disposable local redis-server: integers, simple strings and errors are all these checks read. */
function command(port: number, parts: (string | number)[]): Promise<string | number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let reply = Buffer.alloc(0);
    socket.setTimeout(10_000, () => socket.destroy(new Error("Disposable Redis timeout")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`*${parts.length}\r\n${parts.map((value) => `$${Buffer.byteLength(String(value))}\r\n${value}\r\n`).join("")}`));
    socket.on("data", (chunk) => {
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf("\r\n");
      if (end < 0) return;
      socket.destroy();
      const kind = reply.toString("ascii", 0, 1), value = reply.toString("utf8", 1, end);
      if (kind === "-") reject(new Error(value));
      else if (kind === ":") resolve(Number(value));
      else if (kind === "+") resolve(value);
      else reject(new Error(`Unexpected disposable Redis reply ${kind}`));
    });
  });
}

/** The deletion script on a real redis-server, opt-in: ASSIST_REMIND_REDIS_SERVER=/path/to/redis-server. */
async function nativeForget(): Promise<void> {
  const binary = process.env.ASSIST_REMIND_REDIS_SERVER;
  if (!binary) {
    console.log("Native Redis check not run: set ASSIST_REMIND_REDIS_SERVER to a local redis-server binary.");
    return;
  }
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No disposable Redis port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  const server = spawn(binary, ["--bind", "127.0.0.1", "--port", String(port), "--protected-mode", "yes", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      ready = await command(port, ["PING"]).then((value) => value === "PONG", () => false);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!ready) throw new Error("Disposable Redis did not start");
    const forget = async (count: number) => {
      await command(port, ["FLUSHALL"]);
      const members = Array.from({ length: count }, (_, n) => `cs_test_${String(n).padStart(24, "0")}`);
      await command(port, ["SADD", who, ...members]);
      await command(port, ["MSET", ...members.flatMap((s) => [yes(s), consent(s)])]);
      const keys = [who, ...members.map(yes)];
      const gone = await command(port, ["EVAL", FORGET_IF_SAME, keys.length, ...keys, ...members]).catch((error: Error) => `refused: ${error.message}`);
      return [gone, await command(port, ["DBSIZE"])];
    };
    is("real Redis: two yeses and their note go", await forget(2), [3, 0]);
    is("real Redis: 9,000 yeses and their note go, never refused for their number", await forget(9_000), [9_001, 0]);
    await command(port, ["FLUSHALL"]);
    await command(port, ["SADD", who, session("a"), session("b")]);
    is("real Redis: a note that changed is left whole", [await command(port, ["EVAL", FORGET_IF_SAME, 2, who, yes(session("a")), session("a")]), await command(port, ["SCARD", who])], [-1, 2]);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = new Promise<void>((resolve) => server.once("exit", () => resolve()));
      server.kill("SIGTERM");
      await stopped;
    }
  }
}

void (async () => {
  part("Control: nothing in between, the yeses and their note go");
  await seed(session("a"), session("b"));
  is("two yeses and the note", await forgetAssistReminderPerson(STATS, EMAIL), 3);
  is("all gone", [await exists(yes(session("a"))), await exists(yes(session("b"))), await scard()], [0, 0, 0]);
  // The stand-in's SMEMBERS leaves an empty set behind where Redis would not, so only "finished" is held here.
  is("nothing kept: the erasure finishes", typeof (await outcome(() => forgetAssistReminderPerson(STATS, EMAIL))), "number");

  part("Race: a yes written between the read of the note and the deletion");
  await seed(session("a"));
  between = session("c");
  const removed = await outcome(() => forgetAssistReminderPerson(STATS, EMAIL));
  is("the race ran", between, null);
  const orphan = (await exists(yes(session("c")))) === 1 && (await noted(session("c"))) === 0;
  is("the yes written in between is never left with the address and no note", orphan, false);
  is("the yes read before is gone", await exists(yes(session("a"))), 0);
  is("the erasure deleted it too, or said what it removed", removed, 3);
  is("a second erasure leaves nothing with the address", [await outcome(() => forgetAssistReminderPerson(STATS, EMAIL)), await exists(yes(session("c"))), await scard()], [0, 0, 0]);

  part("Rule 24: the deletion's reply read in its exact shape");
  const deletion: [string, unknown][] = [
    ["OK", "OK"],
    ["null", null],
    ["a fraction", 1.5],
    ["a number as text", "2"],
    ["a list", [2]],
    ["below zero", -2],
    ["more than the note and its yeses", 99],
  ];
  for (const [what, reply] of deletion) {
    await seed(session("a"));
    bad = { commands: ["DEL", "EVAL", "EVALSHA"], reply: () => reply };
    is(`a deletion answered ${what}: the part is not finished`, await outcome(() => forgetAssistReminderPerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
  }

  part("Rule 24: the note's reply read in its exact shape");
  const note: [string, unknown][] = [
    ["null", null],
    ["text", "cs_test_x"],
    ["a list with a number", [7]],
    ["a list with null", [null]],
  ];
  for (const [what, reply] of note) {
    await seed(session("a"));
    bad = { commands: ["SMEMBERS"], reply: () => reply };
    is(`a note answered ${what}: the part is not finished`, await outcome(() => forgetAssistReminderPerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
    is(`and after a note answered ${what}, the yes is still found by the next erasure`, [await exists(yes(session("a"))), await noted(session("a"))], [1, 1]);
  }

  part("Rounds: a note that changes in every round is never deleted blind");
  await seed(session("a"));
  always = 1;
  const busy = await outcome(() => forgetAssistReminderPerson(STATS, EMAIL));
  const written = always - 1;
  always = 0;
  is("the note changed in each of the three rounds: the part is not finished", [busy, written], ["rejected: Error", 3]);
  const [members] = await redisPipeline([["SMEMBERS", who]]);
  const sessions = (members as string[]).slice().sort();
  is("every yes, the first and the three written meanwhile, is still noted under the address", sessions.length, 4);
  is("and each is still there, for the next erasure to find", (await Promise.all(sessions.map((s) => exists(yes(s))))).every((n) => n === 1), true);
  is("the next erasure, with nothing in between, removes them all", [await forgetAssistReminderPerson(STATS, EMAIL), await scard()], [5, 0]);

  part("Size: the deletion on a real Redis");
  await nativeForget();

  done();
})();
