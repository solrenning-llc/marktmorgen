/**
 * The demo store's one-run-at-a-time lock is read exactly (CX-123 rules 24 and 30; review 6732896949 on #2986, LEVE 2).
 *
 * ensureDemoStore (lib/demo-seed.ts) took `nl:house:seed:lock` with SET NX "1", read only nil as "another run holds
 * it" and anything else (no reply, a reply in another shape) as its own, and let go with a plain DEL whoever held it.
 * So a lost answer let it build the demo store beside another run of itself and delete that run's lock, and a run
 * whose lock ran out deleted the next run's. It now reads the lock as the cron jobs do (lib/claim-mark.ts): "OK", or
 * this run's own value read back, is ours; nil, or another value read back, is busy; any other answer is unknown, so
 * nothing is built, nothing is let go, and "lock:unknown" is named. At the end it lets go only of its own value.
 *
 * Synthetic only: Redis is the in-memory double; files, pictures and Stripe are stand-ins that never reach anything.
 */
import { type SeedDeps, ensureDemoStore } from "@/lib/demo-seed";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LOCK = "nl:house:seed:lock";
const MARK = "nl:house:seed";

const deps: SeedDeps = {
  putFile: async () => {},
  removeFile: async () => {},
  fetchBytes: async () => {
    throw new Error("no_stand_in");
  },
};
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

type Commands = (string | number)[][];
type Outcome = { ran: boolean; pending: string[]; built: number; lockAfter: unknown; markWritten: boolean };

const MALFORMED: [string, unknown][] = [
  ["no reply at all", []],
  ["QUEUED", ["QUEUED"]],
  ["a number", [1]],
];

/**
 * One call. `holder`: the value another run already holds the lock with. `reply`: what the lock's own SET NX answers
 * (undefined: Redis's own answer); `landed`: the SET is applied before the odd answer. `takeOver`: once the build
 * starts, the lock runs out and the next run takes it with this value.
 */
async function seed(options: { holder?: string; reply?: unknown; landed?: boolean; takeOver?: string } = {}): Promise<Outcome> {
  redis.clear();
  if (options.holder) redis.run(["SET", LOCK, options.holder, "EX", 300]);
  const real = redis.pipeline.bind(redis);
  let answered = false;
  let built = 0;
  let tookOver = false;
  redis.pipeline = (async (commands: Commands) => {
    const first = commands[0];
    if (!answered && first?.[0] === "SET" && first?.[1] === LOCK) {
      answered = true;
      if (options.reply === undefined) return real(commands);
      if (options.landed) await real(commands);
      return options.reply;
    }
    const touchesLock = commands.every((command) => command.slice(1).includes(LOCK));
    const readsMark = commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === MARK;
    if (answered && !touchesLock && !readsMark) {
      built += 1;
      if (options.takeOver && !tookOver) {
        tookOver = true;
        redis.run(["SET", LOCK, options.takeOver, "EX", 300]);
      }
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    const result = await ensureDemoStore(deps);
    return { ran: result.ran, pending: result.pending, built, lockAfter: redis.run(["GET", LOCK]), markWritten: redis.run(["GET", MARK]) !== null };
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_DEMO_SECRET_KEY = "sk_test_demo_seed_lock_stand_in";

  part("another run holds the demo store's lock");
  const busy = await seed({ holder: "another-run" });
  is("Redis answers nil: busy, nothing built, the other run's lock kept", [busy.ran, busy.built, busy.lockAfter], [false, 0, "another-run"]);
  for (const [label, reply] of MALFORMED) {
    const held = await seed({ holder: "another-run", reply });
    // Before: anything but nil was read as ours, the store was built, and the finally deleted the other run's lock.
    is(`answered ${label}: read back as another run's, nothing built, its lock kept`, [held.ran, held.built, held.lockAfter], [false, 0, "another-run"]);
    const free = await seed({ reply });
    // Before: read as ours and built. Now: not read back as ours, so unknown: nothing built, nothing left, and named.
    is(`not held, answered ${label} and not landed: unknown, nothing built or written, nothing left, named`, [free.ran, free.built, free.markWritten, free.lockAfter, free.pending.includes("lock:unknown")], [false, 0, false, null, true]);
  }

  part("a run that is its own");
  const healthy = await seed();
  is("Redis answers OK: it builds, writes its mark and lets its own lock go", [healthy.ran, healthy.built > 0, healthy.markWritten, healthy.lockAfter], [true, true, true, null]);
  const landed = await seed({ reply: [], landed: true });
  is("the answer was lost but the write landed: read back as ours, built, and let go", [landed.ran, landed.built > 0, landed.lockAfter], [true, true, null]);
  const overtaken = await seed({ takeOver: "the-next-run" });
  // Before: its finally deleted whoever held the lock, here the next run's.
  is("its lock ran out and the next run took it: the next run's lock is kept", [overtaken.ran, overtaken.lockAfter], [true, "the-next-run"]);

  done();
}

void main();
