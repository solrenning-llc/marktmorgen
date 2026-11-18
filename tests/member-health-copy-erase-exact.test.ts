/**
 * The ten-minute copy of a store's member scores is erased exactly (CX-123 rules 24 and 30;
 * lib/member-health.ts, forgetHealthCopy, run by lib/person-erasure.ts).
 *
 * The copy (nl:health:<statsId>) holds each running member's address, so a person's deletion deletes it. Its DEL
 * reply used to be read as `Number(gone) || 0`: a reply of another shape (a string, a negative number, a count
 * one key cannot give, nothing at all) counted as a number or as 0, and the step was reported done while the copy
 * could still be kept. Now:
 *
 *   - only an exact 0 (it was not there) or 1 (deleted) is read; anything else throws UnknownReplyError;
 *   - the erasure then says it is not finished (reason "incomplete", with this step in `failed`), and pressing
 *     again finishes it;
 *   - the healthy path is unchanged: 1 when the copy was there, 0 when Redis confirms it was not.
 *
 * Synthetic only: the in-memory Redis stand-in with the one DEL bent, and a fetch stub.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { forgetHealthCopy } from "@/lib/member-health";
import { ERASERS, erasePerson, erasureScope } from "@/lib/person-erasure";
import { UnknownReplyError } from "@/lib/redis-reply";
import { normaliseEmail } from "@/lib/auth";
import type { Store } from "@/lib/store";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let copyKey = "";
let commandsSeen = 0;
/** How the copy's DEL is answered: as Redis answers it, or with these replies without running it, or by throwing. */
let bend: { replies: unknown[] } | "throw" | null = null;
redis.pipeline = (async (commands: Command[]) => {
  commandsSeen += commands.length;
  const hits = commands.length === 1 && commands[0][0] === "DEL" && commands[0][1] === copyKey && commands[0].length === 2;
  if (hits && bend === "throw") throw new Error("Redis request failed with status 503");
  if (hits && bend !== null && bend !== "throw") return bend.replies;
  return real(commands);
}) as typeof redis.pipeline;

const PERSON = normaliseEmail("tess@example.com");
const keepCopy = () => real([["SET", copyKey, JSON.stringify({ at: 1, members: [{ sub: "sub_HealthCopy01", email: PERSON }] }), "EX", 600]]);
const copyKept = async () => (await real([["EXISTS", copyKey]]))[0] === 1;

async function outcome(run: () => Promise<number>): Promise<string> {
  try {
    return `answered ${await run()}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  }
}

const UNKNOWN: [string, unknown[]][] = [
  ["the count as a string", ["1"]],
  ["a negative count", [-1]],
  ["a count one key cannot give", [2]],
  ["a fraction", [0.5]],
  ["null", [null]],
  ["undefined", [undefined]],
  ["a list holding the count", [[1]]],
  ["no reply at all", []],
  ["two replies for one command", [1, 1]],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_health_copy_erase_stand_in";
  process.env.RESEND_API_KEY = "re_test_health_copy_erase_stand_in";
  const world = await makeWorld();
  await seedPerson(world, PERSON, null);
  const store = world.store;
  copyKey = `nl:health:${store.statsId}`;

  part("Healthy controls");
  await keepCopy();
  is("the copy is there before", await copyKept(), true);
  is("a DEL Redis answers 1 is the copy deleted", await outcome(() => forgetHealthCopy(store)), "answered 1");
  is("and the copy is gone", await copyKept(), false);
  is("a DEL Redis answers 0 is a copy confirmed not there", await outcome(() => forgetHealthCopy(store)), "answered 0");
  const before = commandsSeen;
  const noStats: Store = { ...store, statsId: null };
  is("a store with no stats id has no copy, and Redis is not asked", [await outcome(() => forgetHealthCopy(noStats)), commandsSeen - before], ["answered 0", 0]);

  for (const [label, replies] of UNKNOWN) {
    part(`forgetHealthCopy: the DEL answers ${label}`);
    await keepCopy();
    bend = { replies };
    const said = await outcome(() => forgetHealthCopy(store));
    bend = null;
    is("an unknown reply is never a deletion done: it throws UnknownReplyError", said, "unknown");
    is("the copy may still be kept (here it is), so the step is not done", await copyKept(), true);
    is("a retry with Redis answering normally deletes it", [await outcome(() => forgetHealthCopy(store)), await copyKept()], ["answered 1", false]);
  }

  part("forgetHealthCopy: Redis does not answer");
  await keepCopy();
  bend = "throw";
  is("a failed request is not done either", await outcome(() => forgetHealthCopy(store)), "threw");
  bend = null;
  is("and the copy is still there for a retry", await copyKept(), true);
  await real([["DEL", copyKey]]);

  part("The erasure step runs it");
  const eraser = ERASERS.find((e) => e.module === "lib/member-health.ts");
  is("the person's deletion has a step for the copy", eraser !== undefined, true);
  const scope = await erasureScope(store, PERSON);
  is("the scope reads", scope !== null, true);
  await keepCopy();
  bend = { replies: ["1"] };
  const step = await outcome(async () => eraser!.run(scope!, [], new Set()));
  bend = null;
  is("the step throws on an unknown reply instead of counting it", step, "unknown");

  part("A person's deletion while the copy's DEL answers in another shape");
  await keepCopy();
  bend = { replies: [-1] };
  const result = await erasePerson(store, PERSON, { kind: "person" });
  bend = null;
  is(
    "the deletion is never answered done: it is incomplete, naming the copy's step",
    [result.ok, result.ok ? "" : result.reason, !result.ok && result.reason === "incomplete" ? result.failed.includes("lib/member-health.ts") : false],
    [false, "incomplete", true],
  );
  is("the copy is still kept, so pressing again has something to finish", await copyKept(), true);

  part("Pressed again with Redis answering normally");
  const again = await erasePerson(store, PERSON, { kind: "person" });
  is("done", again.ok, true);
  is("and the copy is gone", await copyKept(), false);

  done();
}

void main();
