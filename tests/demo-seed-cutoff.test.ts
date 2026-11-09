/**
 * Building the demo store ends before its lock does (CX-123 rules 23 and 30; pre-review LEVE on claude5/once-locks-siblings).
 *
 * ensureDemoStore (lib/demo-seed.ts) holds `nl:house:seed:lock` for 120 s and then builds the store with some fifty
 * requests (Redis up to 5 s each, Stripe 20 s, Blob 45 s). /demo had no cutoff of its own, so one slow build could
 * outlive its lock, and the next visit (or the daily job) would start a second build beside it. The build now runs
 * inside a cutoff (lib/fetch-timeout.ts, withCutoff) that leaves room, inside the lock, to write the mark and let the
 * lock go; a build that is cut is named "run:cutoff" and never written down as finished, and a later run resumes it.
 *
 * Synthetic only: the clock is simulated; Redis is the in-memory double; files, pictures and Stripe are stand-ins
 * that never reach anything. Each stand-in request takes 11 simulated seconds and, like `timed`, is given up at the
 * cutoff, so a build that is never cut would take some 230 s.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_STORE, RETRY_SECONDS, type SeedDeps, ensureDemoStore } from "@/lib/demo-seed";
import { givenUp, timeLeft } from "@/lib/fetch-timeout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LOCK = "nl:house:seed:lock";
const MARK = "nl:house:seed";
const LOCK_MS = 120_000;
const REQUEST_MS = 11_000;

const realNow = Date.now.bind(Date);
let clock = realNow();
Date.now = () => clock;

/** One stand-in request: it takes `REQUEST_MS` of the simulated clock, and is given up at the cutoff as `timed` does. */
let slow = true;
function request(): void {
  if (!slow) return;
  const room = timeLeft();
  if (room < 50) throw givenUp(new Error("there was no time left to ask"));
  if (room < REQUEST_MS) {
    clock += room;
    throw givenUp(new Error("the request took too long"));
  }
  clock += REQUEST_MS;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x52, 0x49, 0x46, 0x46, 56, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0]);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  return bytes;
}

const deps: SeedDeps = {
  putFile: async () => request(),
  removeFile: async () => request(),
  fetchBytes: async (url) => {
    request();
    if (url.includes(DEMO_STORE.photo.id)) return webp(480, 480);
    return url.includes("w=800") ? webp(800, 450) : webp(1200, 675);
  },
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    return new Response(JSON.stringify({ id: `cs_test_${"d".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/demo" }));
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

type Commands = (string | number)[][];

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_platform_only_a_stand_in";
  process.env.STRIPE_DEMO_SECRET_KEY = "sk_test_demo_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_demo_only";
  redis.clear();

  // When the lock was taken, and when the mark was written and the lock let go, on the simulated clock.
  const real = redis.pipeline.bind(redis);
  let claimedAt = 0;
  let markAt = 0;
  let releasedAt = 0;
  redis.pipeline = (async (commands: Commands) => {
    const [first] = commands;
    if (first?.[0] === "SET" && first?.[1] === LOCK && !claimedAt) claimedAt = clock;
    if (first?.[0] === "SET" && first?.[1] === MARK) markAt = clock;
    if (commands.some((command) => String(command[0]).startsWith("EVAL") && command.includes(LOCK))) releasedAt = clock;
    return real(commands);
  }) as typeof redis.pipeline;

  part("a build that would take longer than its lock is cut before the lock runs out");
  const start = clock;
  const cut = await ensureDemoStore(deps);
  const took = clock - start;
  // Before: no cutoff, so every request ran its full time and the build took some 230 s, past its 120 s lock.
  is("the run comes back before its 120 s lock would run out", took < LOCK_MS, true);
  is("it says it ran, and names the cut", [cut.ran, cut.pending.includes("run:cutoff")], [true, true]);
  is("the mark was written while the lock was still its own", markAt > 0 && markAt - claimedAt < LOCK_MS, true);
  is("and it let its own lock go, before the lock ran out", [(await real([["GET", LOCK]]))[0], releasedAt > 0 && releasedAt - claimedAt < LOCK_MS], [null, true]);
  const kept = JSON.parse(((await real([["GET", MARK]]))[0] as string) ?? "{}") as { pending?: string[] };
  is("nothing cut is written down as finished: the mark names the cut", kept.pending?.includes("run:cutoff"), true);

  part("the next visit does not take a cut build for a finished one, and a later run resumes it");
  slow = false;
  const soon = await ensureDemoStore(deps);
  is("a visit a moment later is not told the store is complete", [soon.ran, soon.pending.length > 0], [false, true]);
  clock += (RETRY_SECONDS + 1) * 1000;
  const resumed = await ensureDemoStore(deps);
  is("after the wait, a run picks it up and finishes it", [resumed.ok, resumed.pending, resumed.ran], [true, [], true]);
  const again = await ensureDemoStore(deps);
  is("and then it is one read", [again.ok, again.pending, again.ran], [true, [], false]);

  part("every caller of ensureDemoStore is bounded (rule 30)");
  const page = readFileSync(join(process.cwd(), "app/demo/page.tsx"), "utf8");
  const limit = /export const maxDuration = (\d+);/.exec(page);
  is("/demo declares a limit no longer than the lock", limit !== null && Number(limit[1]) <= LOCK_MS / 1000, true);
  const cron = readFileSync(join(process.cwd(), "app/api/cron/plans/route.ts"), "utf8");
  is("the daily job runs inside its own cutoff", /withCutoff\(Date\.now\(\) \+ 57_000/.test(cron) && /export const maxDuration = 60;/.test(cron), true);

  redis.pipeline = real;
  Date.now = realNow;
  done();
}

void main();
