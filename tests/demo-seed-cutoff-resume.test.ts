/**
 * A build of the demo store that is cut keeps what it did (CX-123 rules 23 and 30; pre-review MÉDIO on
 * claude5/once-locks-siblings).
 *
 * ensureDemoStore (lib/demo-seed.ts) runs its build inside a cutoff that ends 100 s after the lock is taken, and
 * stops between two steps once the cutoff has come. That stop used to fall through to the run's last catch, which
 * wrote a "failed" mark with the store, photo and pictures of the mark before the run, not of what the run did: the
 * first build made the store but said `store: false` (so /demo said "being set up" for ten minutes), and every later
 * run fetched the photograph and the pictures again. With requests that stay slow, no run ever finished. Now a cut
 * run writes its own mark (what it finished, "run:cutoff" among what is missing), and the next run does only the rest.
 * A step left in the middle at the cutoff is never written down as done.
 *
 * Synthetic only: the clock is simulated; Redis is the in-memory double; files, pictures and Stripe are stand-ins
 * that never reach anything. Each slow stand-in request takes 11 simulated seconds and, like `timed`, is given up at
 * the cutoff.
 */
import { DEMO_PRODUCT, DEMO_STORE, RETRY_SECONDS, type SeedDeps, ensureDemoStore } from "@/lib/demo-seed";
import { givenUp, timeLeft } from "@/lib/fetch-timeout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LOCK = "nl:house:seed:lock";
const MARK = "nl:house:seed";
const LOCK_MS = 120_000;
const REQUEST_MS = 11_000;
/** Where the product's picture comes from, as the mark writes it down once the picture is in place. */
const PRODUCT_PICTURE = `${DEMO_PRODUCT.image.id}?${DEMO_PRODUCT.image.query}|${DEMO_PRODUCT.image.small}`;

const realNow = Date.now.bind(Date);
let clock = realNow();
Date.now = () => clock;

/** Gives the request up at the cutoff, after waiting for all of the time that is left, as `timed` does. */
function hang(): never {
  const room = timeLeft();
  if (Number.isFinite(room) && room > 0) clock += room;
  throw givenUp(new Error("the request took too long"));
}

let slow = true;
/** A request that never answers (the product picture's small copy, in the second part). */
let stuck: (url: string) => boolean = () => false;
let photoFetches = 0;
let productPictureFetches = 0;
function request(): void {
  if (!slow) return;
  const room = timeLeft();
  if (room < 50) throw givenUp(new Error("there was no time left to ask"));
  if (room < REQUEST_MS) hang();
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
    if (stuck(url)) hang();
    request();
    if (url.includes(DEMO_STORE.photo.id)) {
      photoFetches += 1;
      return webp(480, 480);
    }
    if (url.includes(DEMO_PRODUCT.image.id)) productPictureFetches += 1;
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
type Kept = { store?: boolean; photo?: string; image?: string; pending?: string[] };

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_platform_only_a_stand_in";
  process.env.STRIPE_DEMO_SECRET_KEY = "sk_test_demo_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_demo_only";
  redis.clear();

  // When this run took the lock, wrote the mark and let the lock go, on the simulated clock.
  const real = redis.pipeline.bind(redis);
  let claimedAt = 0;
  let markAt = 0;
  let releasedAt = 0;
  redis.pipeline = (async (commands: Commands) => {
    const [first] = commands;
    if (first?.[0] === "SET" && first?.[1] === LOCK) claimedAt = clock;
    if (first?.[0] === "SET" && first?.[1] === MARK) markAt = clock;
    if (commands.some((command) => String(command[0]).startsWith("EVAL") && command.includes(LOCK))) releasedAt = clock;
    return real(commands);
  }) as typeof redis.pipeline;
  const kept = async () => JSON.parse(((await real([["GET", MARK]]))[0] as string) ?? "{}") as Kept;

  part("every slow run keeps what it did, so the photograph is fetched once and the build finishes");
  const runs: { ok: boolean; pending: string[]; took: number; inLock: boolean; mark: Kept }[] = [];
  for (let i = 0; i < 6; i += 1) {
    const start = clock;
    claimedAt = markAt = releasedAt = 0;
    const r = await ensureDemoStore(deps);
    const inLock = !r.ran || (markAt > 0 && releasedAt > 0 && markAt - claimedAt < LOCK_MS && releasedAt - claimedAt < LOCK_MS);
    runs.push({ ok: r.ok, pending: r.pending, took: clock - start, inLock, mark: await kept() });
    clock += (RETRY_SECONDS + 1) * 1000;
  }
  // Before: the cut fell through to the last catch, and the mark kept the store, photo and pictures of the mark
  // before the run (none), so the first run said store=false and every run fetched the photograph again, never ending.
  is("the store made in the first, cut run is said to be there (visitors are let in)", [runs[0].ok, runs[0].mark.store], [true, true]);
  is("the first run's mark keeps the photograph it put in place", runs[0].mark.photo, DEMO_STORE.photo.id);
  is("and names the cut, so it is not taken for a finished build", runs[0].mark.pending?.includes("run:cutoff"), true);
  is("the photograph is fetched once, not again on every run", photoFetches, 1);
  is("the product picture is fetched twice (its two sizes), once", productPictureFetches, 2);
  is("a later run finishes the build", runs.some((r) => r.ok && r.pending.length === 0), true);
  is("every run comes back before its 120 s lock would run out", runs.every((r) => r.took < LOCK_MS), true);
  is("and wrote its mark and let its lock go while the lock was its own", runs.every((r) => r.inLock), true);

  part("a step left in the middle at the cutoff is never written down as done");
  redis.clear();
  slow = false;
  photoFetches = 0;
  productPictureFetches = 0;
  // The product picture's large size is fetched and put; its small copy never answers, until the cutoff.
  stuck = (url) => url.includes(DEMO_PRODUCT.image.id) && url.includes("w=800");
  const cut = await ensureDemoStore(deps);
  const middle = await kept();
  is("the run names the cut", [cut.ran, cut.ok, cut.pending.includes("run:cutoff")], [true, true, true]);
  is("what it finished is kept: the store and its photograph", [middle.store, middle.photo], [true, DEMO_STORE.photo.id]);
  is("the picture left in the middle is not written down as done", middle.image === PRODUCT_PICTURE, false);
  is("and its step is named among what is missing", middle.pending?.some((p) => p.startsWith("image:")), true);
  stuck = () => false;
  clock += (RETRY_SECONDS + 1) * 1000;
  const resumed = await ensureDemoStore(deps);
  const after = await kept();
  is("the next run finishes it", [resumed.ok, resumed.pending, resumed.ran], [true, [], true]);
  is("without fetching the photograph again, and with the picture fetched whole again", [photoFetches, productPictureFetches], [1, 3]);
  is("and the picture is now written down as done", after.image, PRODUCT_PICTURE);

  redis.pipeline = real;
  Date.now = realNow;
  done();
}

void main();
