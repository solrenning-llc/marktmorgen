/**
 * #5010 row 182, the second lock family (coordinator's B2, c1bf: cap each lock wait so it fits the shape its route is
 * billed at, answering busy past it; one PR per lock family). A podcast's and a course's changes from the studio are
 * made one at a time under the podcast's or the course's lock (nl:pod:<id>:lock, nl:course:<id>:lock), and those studio
 * routes are billed at SHAPES.studio's seconds (tests/plan-cost-registry.ts). Each waited 15,000 ms for the lock, ten
 * times the 1.5 s the shape holds, so a busy podcast or course was priced far below what one request can cost.
 *
 * Now every lock an app/api/store route waits for waits STUDIO_LOCK_WAIT_MS (lib/redis-lock.ts), whose whole wait at
 * its worst, every sleep's jitter included, leaves at least a third of the shape for the route's work; past it the
 * route answers with its existing "busy" (409), and nothing is written: the podcast and the course are left exactly as
 * they were. The product's removal still removes the product: dropping its podcast's public feed settings was already
 * best effort there, and one not confirmed gone is erased with the store's closing (lib/plan-closing.ts, which runs from
 * a scheduled job and keeps its own wait). Measured on the real takeLock with a virtual clock; synthetic only.
 */
import { NextRequest } from "next/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import * as redisLock from "@/lib/redis-lock";
import { addProduct, claimHandle, ensureStatsId, setProductPodcast, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readPodcast, savePodcast } from "@/lib/podcast";
import type { Podcast } from "@/lib/podcast-rules";
import { POST as podcastRoute } from "@/app/api/store/podcast/route";
import { POST as settingsRoute } from "@/app/api/store/podcast/public-settings/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { SHAPES } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
globalThis.fetch = (async () => {
  throw new Error("no request may be made here");
}) as typeof fetch;

type Command = (string | number)[];
const OWNER = "content-lock@example.com";
const ORIGIN = "https://marktmorgen.com";
const POD = "d".repeat(32);
const shapeMs = SHAPES.studio.seconds * 1_000;
const room = (shapeMs * 2) / 3;
const studioWait = (redisLock as Record<string, unknown>).STUDIO_LOCK_WAIT_MS;

let session = "";
async function call(route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>): Promise<{ status: number; error?: unknown; ok?: unknown }> {
  const response = await route(new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const json = (await response.json().catch(() => ({}))) as { error?: unknown; ok?: unknown };
  return { status: response.status, error: json.error, ok: json.ok };
}

/**
 * Runs `work` while another change holds every podcast and course lock the whole time, on a virtual clock with the
 * largest jitter: every SET NX of such a lock is refused, every sleep moves the clock on by its delay.
 */
async function whileHeld<T>(work: () => Promise<T>): Promise<{ result: T; slept: number; tries: number }> {
  const real = redis.pipeline.bind(redis);
  const savedNow = Date.now;
  const savedRandom = Math.random;
  const savedTimeout = globalThis.setTimeout;
  let now = Date.UTC(2026, 10, 23);
  const start = now;
  let tries = 0;
  redis.pipeline = (async (commands: Command[]) => {
    const [first] = commands;
    if (commands.length === 1 && first[0] === "SET" && /^nl:(pod|course):[^:]+:lock$/.test(String(first[1])) && first.includes("NX")) {
      tries += 1;
      return [null];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  Date.now = () => now;
  Math.random = () => 0.999;
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    now += Number(delay ?? 0);
    queueMicrotask(run);
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    const result = await work();
    return { result, slept: now - start, tries };
  } finally {
    Date.now = savedNow;
    Math.random = savedRandom;
    globalThis.setTimeout = savedTimeout;
    redis.pipeline = real;
  }
}

function podcast(id: string): Podcast {
  const one = (n: number) => ({ id: `ep000000000${n}`, title: `Episode ${n}`, notes: "", pathname: `stores/x/p/${n}.mp3`, bytes: 1000 + n, contentType: "audio/mpeg", at: 1_790_000_000 + n });
  return { id, episodes: [one(1), one(2)] };
}

/** Every route file under a folder. */
function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routes(path) : name === "route.ts" ? [path] : [];
  });
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "contentlock", "Content Lock", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_lock00001", subscriptionId: "sub_lock00001", active: true, tier: "creator", period: paidPeriod() });
  session = await openSession(OWNER);
  const show = await addProduct(OWNER, "A show", "A weekly show.", "9", null);
  if (!show.ok) throw new Error("no product");
  if (!(await setProductPodcast(OWNER, show.product.id, { id: POD, episodes: 2 })).ok) throw new Error("no podcast");
  await savePodcast(podcast(POD));
  const lessons = await addProduct(OWNER, "A course", "A short course.", "19", null);
  if (!lessons.ok) throw new Error("no course product");
  const enabled = await call(courseRoute, "/api/store/course", { action: "enable", id: lessons.product.id });
  if (enabled.status !== 200) throw new Error(`no course: ${JSON.stringify(enabled)}`);

  part("One wait for every lock a studio route waits for, named once");
  is("lib/redis-lock.ts names STUDIO_LOCK_WAIT_MS", typeof studioWait, "number");
  const inline = routes(join(process.cwd(), "app/api/store")).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/(?:withLock|takeLock)\(\s*[^,]+,\s*[^,]+,\s*([^,)]+?)\s*[,)]/g)].filter((m) => m[1] !== "STUDIO_LOCK_WAIT_MS").map((m) => `${path.slice(process.cwd().length + 1)}: ${m[1]}`),
  );
  is("no app/api/store route waits for a lock longer than STUDIO_LOCK_WAIT_MS", inline, []);

  part("A podcast change while another holds the podcast's lock, at its worst");
  const before = JSON.stringify(await readPodcast(POD));
  const edit = await whileHeld(() => call(podcastRoute, "/api/store/podcast", { action: "edit", id: show.product.id, episode: "ep0000000001", title: "Renamed", notes: "" }));
  console.log(`a podcast change: ${edit.slept} ms in ${edit.tries} tries, of the studio shape's ${shapeMs} ms`);
  is("refused as busy (409), never written over the other change", [edit.result.status, edit.result.error], [409, "busy"]);
  is("and the podcast is left as it was", JSON.stringify(await readPodcast(POD)), before);
  is(`its whole wait (${edit.slept} ms) leaves at least a third of the studio shape (${shapeMs} ms) for the route's work`, edit.slept <= room, true);

  part("A podcast's public feed settings while the podcast's lock is held");
  const settings = await whileHeld(() => call(settingsRoute, "/api/store/podcast/public-settings", { action: "on", id: show.product.id, category: "Education", explicit: false, understood: true }));
  console.log(`a public feed change: ${settings.slept} ms in ${settings.tries} tries`);
  is("refused as busy (409)", [settings.result.status, settings.result.error], [409, "busy"]);
  is(`within the studio shape's room (${settings.slept} ms)`, settings.slept <= room, true);

  part("A course change while another holds the course's lock");
  const course = await whileHeld(() => call(courseRoute, "/api/store/course", { action: "disable", id: lessons.product.id }));
  console.log(`a course change: ${course.slept} ms in ${course.tries} tries`);
  is("refused as busy (409)", [course.result.status, course.result.error], [409, "busy"]);
  is("and the product is still a course", Boolean((await readListing((await storeForEmail(OWNER)) as Store, lessons.product.id))?.course), true);
  is(`within the studio shape's room (${course.slept} ms)`, course.slept <= room, true);

  part("Removing a podcast's product while its lock is held: removed, its feed settings left to the store's closing");
  const removal = await whileHeld(() => call(productRoute, "/api/store/product", { action: "remove", id: show.product.id }));
  console.log(`a product removal: ${removal.slept} ms in ${removal.tries} tries`);
  is("the product is removed", [removal.result.status, removal.result.ok], [200, true]);
  is(`within the studio shape's room (${removal.slept} ms)`, removal.slept <= room, true);
  done();
}

void main();
