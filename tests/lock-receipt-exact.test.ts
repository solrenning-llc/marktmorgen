/**
 * Codex G on #2806 (proof codex/g-review-2806-lock-receipts 2804bb83, tests/g2806-script-envelope.proof.ts): a lock
 * script's receipt is read only in its exact shape. One command sent, one reply back, held in the array's own data slot:
 * an extra reply ([1, 0]), a slot that is a getter, or a slot inherited from the prototype is unknown, never a 1. Each of
 * those would confirm a hold, a fenced write or a fenced delete that never happened, while the lock is another's. The
 * same exact read covers the acquisition receipt (rule 30): a getter "OK" never takes a lock.
 * A slot counts only by its own data value, never by a `value` inherited from a polluted Object.prototype (G, a586f20d).
 */
import { deleteIfHeldOnly, holdLock, LockBusyError, setIfHeld, takeLock } from "@/lib/redis-lock";
import { repliesFor } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const MODES = ["extra", "accessor", "inherited", "hole"] as const;

function shaped(mode: (typeof MODES)[number], value: unknown, counter: { getters: number }): unknown[] {
  if (mode === "extra") return [value, 0];
  const reply: unknown[] = Array(1);
  if (mode === "accessor") Object.defineProperty(reply, "0", { enumerable: true, get() { counter.getters += 1; return value; } });
  else if (mode === "inherited") Object.setPrototypeOf(reply, Object.assign(Object.create(Array.prototype), { 0: value }));
  return reply;
}

async function main(): Promise<void> {
  part("Codex G's proof: a script receipt not in its exact shape confirms nothing");
  for (const mode of MODES) {
    redis.clear();
    const held = await takeLock("g:lease", 1, 100);
    const clock = Date.now;
    Date.now = () => clock() + 1001;
    await redis.pipeline([["SET", held.key, "legitimate-successor", "NX", "EX", 300], ["SET", "g:target", "before"]]);
    const real = redis.pipeline.bind(redis);
    const counter = { getters: 0 };
    let evals = 0;
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "EVAL") {
        evals += 1;
        return shaped(mode, 1, counter);
      }
      return real(commands);
    }) as typeof redis.pipeline;
    let kept = true, wrote = true, gone = true;
    try {
      kept = await holdLock(held);
      wrote = await setIfHeld(held, "g:target", "after");
      gone = await deleteIfHeldOnly(held, ["g:target"]);
    } finally {
      redis.pipeline = real;
      Date.now = clock;
    }
    is(`${mode}: three script boundaries reached`, evals, 3);
    is(`${mode}: a hold on the successor's lock is not confirmed`, kept, false);
    is(`${mode}: an unwritten record is not confirmed`, wrote, false);
    is(`${mode}: an unapplied deletion is not confirmed`, gone, false);
    is(`${mode}: no getter called`, counter.getters, 0);
    is(`${mode}: the successor's lock and the record are unchanged`, [redis.run(["GET", held.key]), redis.run(["GET", "g:target"])], ["legitimate-successor", "before"]);
  }

  part("The acquisition receipt too: only its exact shape takes a lock");
  for (const mode of MODES) {
    redis.clear();
    const real = redis.pipeline.bind(redis);
    const counter = { getters: 0 };
    redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "SET" ? shaped(mode, "OK", counter) : real(commands))) as typeof redis.pipeline;
    let outcome = "taken";
    try {
      await takeLock("g:acquire", 5, 0);
    } catch (error) {
      outcome = error instanceof LockBusyError ? "busy" : "other";
    } finally {
      redis.pipeline = real;
    }
    is(`${mode}: not taken, said busy`, outcome, "busy");
    is(`${mode}: no getter called`, counter.getters, 0);
  }

  part("Codex G's return (a586f20d): a getter slot stays unknown even when Object.prototype carries a value");
  {
    redis.clear();
    const held = await takeLock("g:pollution", 1, 100);
    const clock = Date.now;
    Date.now = () => clock() + 1001;
    await redis.pipeline([["SET", held.key, "next", "NX", "EX", 300], ["SET", "g:record", "before"]]);
    const real = redis.pipeline.bind(redis);
    const counter = { getters: 0 };
    const reply = shaped("accessor", 1, counter);
    redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "EVAL" ? reply : real(commands))) as typeof redis.pipeline;
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    let parsed: unknown = "unread", kept = true, wrote = true, gone = true;
    try {
      Object.defineProperty(Object.prototype, "value", { value: 1, configurable: true });
      parsed = repliesFor(reply, 1);
      kept = await holdLock(held);
      wrote = await setIfHeld(held, "g:record", "after");
      gone = await deleteIfHeldOnly(held, ["g:record"]);
    } finally {
      if (prior) Object.defineProperty(Object.prototype, "value", prior);
      else Reflect.deleteProperty(Object.prototype, "value");
      redis.pipeline = real;
      Date.now = clock;
    }
    is("the reply is unknown", parsed, null);
    is("no hold, write or delete confirmed", [kept, wrote, gone], [false, false, false]);
    is("no getter called", counter.getters, 0);
    is("the successor's lock and the record are unchanged", [redis.run(["GET", held.key]), redis.run(["GET", "g:record"])], ["next", "before"]);
  }

  part("The exact shapes still work");
  redis.clear();
  const mine = await takeLock("g:healthy", 5, 100);
  is("a hold on our own lock", await holdLock(mine), true);
  is("a fenced write while ours", [await setIfHeld(mine, "g:record", "1"), redis.run(["GET", "g:record"])], [true, "1"]);
  is("a fenced delete while ours", [await deleteIfHeldOnly(mine, ["g:record"]), redis.run(["GET", "g:record"])], [true, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
