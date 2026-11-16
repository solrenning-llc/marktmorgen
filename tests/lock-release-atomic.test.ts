/**
 * Codex G on #2721 (review 5799137499, proof codex/g-review-2721-release-race f9f2a842; C4-20261106-1055-TODOS-59):
 * a lock's release, hold and fenced write never fall back to separate commands when their one script does not run.
 * Read then act as two steps leaves a gap: a lock that ran out between them may be another holder's by then, and the
 * old holder's DEL, EXPIRE or SET would land on it. When the script cannot run, nothing is done: the release leaves
 * the mark to run out at its own expiry, a hold says the lock is not held (the caller must not write), and a fenced
 * write writes nothing. The local stand-in (lib/redis-memory.ts) runs each script as one step, as Redis does.
 */
import { claimMark, releaseMark } from "@/lib/claim-mark";
import { holdLock, releaseLock, setIfHeld, takeLock } from "@/lib/redis-lock";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];

async function main(): Promise<void> {
  part("Codex G's proof: a release whose script fails never deletes the successor's mark");
  for (const job of ["courses", "reminders", "discord", "quiet"]) {
    redis.clear();
    const key = `g:2721:release:${job}`, owner = `g-owner-${job}`, next = `g-successor-${job}`;
    if ((await claimMark(key, 2, owner)) !== "ours") throw new Error("fixture claim not acquired");
    const real = redis.pipeline.bind(redis), clock = Date.now;
    let failed = 0, read = 0;
    redis.pipeline = (async (commands: Commands) => {
      const c = commands[0];
      if (c?.[0] === "EVAL" && c[3] === key) {
        failed += 1;
        // The script did not run; meanwhile the mark ran out and the next run took it.
        const future = clock() + 2001;
        Date.now = () => future;
        await real([["SET", key, next, "NX", "EX", 300]]);
        throw new Error("release EVAL not applied");
      }
      if (c?.[0] === "GET" && c[1] === key) read += 1;
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      await releaseMark(key, owner);
    } finally {
      redis.pipeline = real;
      Date.now = clock;
    }
    is(`${job}: the release's script was tried once`, failed, 1);
    is(`${job}: no read-then-delete after it`, read, 0);
    is(`${job}: the successor's mark is kept`, redis.run(["GET", key]), next);
  }

  part("Codex G's exact race: the old fallback read our mark, then the successor took it, then the DEL landed on it");
  for (const job of ["courses", "reminders", "discord", "quiet"]) {
    redis.clear();
    const key = `g:2721:race:${job}`, owner = `g-owner-${job}`, next = `g-successor-${job}`;
    if ((await claimMark(key, 2, owner)) !== "ours") throw new Error("fixture claim not acquired");
    const real = redis.pipeline.bind(redis), clock = Date.now;
    let deletes = 0;
    redis.pipeline = (async (commands: Commands) => {
      const c = commands[0];
      if (c?.[0] === "EVAL" && c[3] === key) throw new Error("release EVAL not applied");
      if (c?.[0] === "DEL" && c[1] === key) deletes += 1;
      const answer = await real(commands);
      // Where the old fallback read our mark, the successor takes it right after (the gap Codex G showed).
      if (c?.[0] === "GET" && c[1] === key && answer[0] === owner) {
        const future = clock() + 2001;
        Date.now = () => future;
        await real([["SET", key, next, "NX", "EX", 300]]);
      }
      return answer;
    }) as typeof redis.pipeline;
    try {
      await releaseMark(key, owner);
      is(`${job}: after the failed script, no DEL is sent`, deletes, 0);
      // The mark is left to run out at its own expiry; the next run takes it then, and nothing of ours removes it.
      const future = clock() + 2001;
      Date.now = () => future;
      await redis.pipeline([["SET", key, next, "NX", "EX", 300]]);
      is(`${job}: the successor's mark, taken once ours ran out, survives`, redis.run(["GET", key]), next);
    } finally {
      redis.pipeline = real;
      Date.now = clock;
    }
  }

  part("A hold whose script fails says the lock is not held, and extends nothing");
  {
    redis.clear();
    const held = await takeLock("lock:hold", 5, 100);
    const real = redis.pipeline.bind(redis);
    let after = 0;
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "EVAL") throw new Error("hold EVAL not applied");
      after += 1;
      return real(commands);
    }) as typeof redis.pipeline;
    let kept: boolean;
    try {
      kept = await holdLock(held);
    } finally {
      redis.pipeline = real;
    }
    is("not held, so the caller does not write", kept, false);
    is("and no separate GET or EXPIRE was sent", after, 0);
  }

  part("A fenced write whose script fails writes nothing");
  {
    redis.clear();
    const held = await takeLock("lock:fence", 5, 100);
    const real = redis.pipeline.bind(redis);
    let after = 0;
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "EVAL") throw new Error("fenced EVAL not applied");
      after += 1;
      return real(commands);
    }) as typeof redis.pipeline;
    let wrote: boolean;
    try {
      wrote = await setIfHeld(held, "record:fenced", "value");
    } finally {
      redis.pipeline = real;
    }
    is("not written", [wrote, redis.run(["GET", "record:fenced"])], [false, null]);
    is("and no separate GET, EXISTS or SET was sent", after, 0);
  }

  part("On a healthy Redis each is one script, and does what it says");
  redis.clear();
  const mine = await takeLock("lock:healthy", 5, 100);
  is("a hold on our own lock: held", await holdLock(mine), true);
  is("a fenced write while ours: written", [await setIfHeld(mine, "record:a", "1"), redis.run(["GET", "record:a"])], [true, "1"]);
  is("a fenced write of something new, already there: not written", await setIfHeld(mine, "record:a", "2", { absent: true }), false);
  await releaseLock(mine);
  is("our release deletes our lock", redis.run(["GET", "lock:healthy"]), null);
  redis.run(["SET", "lock:other", "someone-else", "EX", 5]);
  await releaseLock({ key: "lock:other", token: "ours", ttlSeconds: 5 });
  is("a release never deletes another holder's lock", redis.run(["GET", "lock:other"]), "someone-else");
  is("a hold on another's lock: not held", await holdLock({ key: "lock:other", token: "ours", ttlSeconds: 5 }), false);
  is("a fenced write under another's lock: not written", [await setIfHeld({ key: "lock:other", token: "ours", ttlSeconds: 5 }, "record:b", "1"), redis.run(["GET", "record:b"])], [false, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
