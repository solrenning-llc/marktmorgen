/**
 * The email job's one-run-at-a-time lock read exactly (app/api/cron/mail,
 * CX-123 rule 24).
 *
 * The lock is taken with SET NX. Only "OK", or this run's own value read back,
 * makes it this run's; nil is another run's. Any other answer is never read as
 * taken by us: nothing is run, and the lock is not let go, because it is not
 * this run's to let go. At the end a run lets go of its own lock only while it
 * still holds this run's value, so a run whose lock ran out never deletes the
 * lock of the run after it.
 *
 * Synthetic data only; the healthy and confirmed-taken answers work as before.
 */
import { GET as mail } from "@/app/api/cron/mail/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

delete process.env.CRON_SECRET;
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const LOCK = "nl:mail:lock";
const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/mail") } as unknown as Parameters<typeof mail>[0];

/** The reply the test puts in place of Redis's own for the lock's SET NX. */
let lockReply: (() => unknown[]) | null = null;
let seen: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  seen.push(...commands);
  if (lockReply && commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === LOCK) return lockReply();
  return pipeline(commands);
}) as typeof redis.pipeline;

async function run(): Promise<{ status: number; busy: boolean; ran: boolean; letGo: boolean }> {
  seen = [];
  let status = -1;
  let body: Record<string, unknown> = {};
  try {
    const response = await mail(request);
    status = response.status;
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    status = -1;
  }
  const onLock = (c: (string | number)[]) => c.slice(1).includes(LOCK) || c.slice(3).includes(LOCK);
  return {
    status,
    busy: body.busy === true,
    // Any command that is not about the lock is a job that ran.
    ran: seen.some((c) => !onLock(c)),
    letGo: seen.some((c) => (c[0] === "DEL" || c[0] === "EVAL") && onLock(c)),
  };
}

const MALFORMED: [string, () => unknown[]][] = [
  ["no reply at all", () => []],
  ["undefined", () => [undefined]],
  ["QUEUED", () => ["QUEUED"]],
  ["a number", () => [1]],
  ["two replies", () => ["OK", "OK"]],
];

async function main(): Promise<void> {
  redis.clear();

  part("Healthy: the lock is taken, the jobs run, and the run's own lock is let go");
  const healthy = await run();
  is("ran and answered", [healthy.status, healthy.ran], [200, true]);
  is("the lock is gone after the run", await pipeline([["GET", LOCK]]), [null]);

  part("Confirmed taken (nil): busy, nothing run, nothing let go");
  await pipeline([["SET", LOCK, "another-run"]]);
  is("busy", await run(), { status: 200, busy: true, ran: false, letGo: false });
  is("the other run's lock is kept", await pipeline([["GET", LOCK]]), ["another-run"]);

  part("Any other answer: nothing run, and another run's lock never let go");
  for (const [label, reply] of MALFORMED) {
    lockReply = reply;
    await pipeline([["SET", LOCK, "another-run"]]);
    const held = await run();
    is(`held by another run, answered ${label}: nothing run, nothing let go`, [held.ran, held.letGo], [false, false]);
    is(`held by another run, answered ${label}: never answered as a run that went`, held.status === 200 && !held.busy, false);
    is(`held by another run, answered ${label}: its lock is kept`, await pipeline([["GET", LOCK]]), ["another-run"]);
    await pipeline([["DEL", LOCK]]);
    const free = await run();
    is(`not held, answered ${label} and not read back as ours: nothing run, nothing let go`, [free.ran, free.letGo], [false, false]);
    lockReply = null;
  }

  part("A run whose lock ran out and was taken by the next never deletes the next run's lock");
  lockReply = null;
  await pipeline([["DEL", LOCK]]);
  const original = redis.pipeline;
  let swapped = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // Once this run holds the lock and starts its jobs, its lock runs out and the next run takes it.
    if (!swapped && !commands.some((c) => c.includes(LOCK))) {
      swapped = true;
      await pipeline([["SET", LOCK, "the-next-run"]]);
    }
    return original(commands);
  }) as typeof redis.pipeline;
  await run();
  redis.pipeline = original;
  is("the next run's lock is still there", await pipeline([["GET", LOCK]]), ["the-next-run"]);

  done();
}

void main();
