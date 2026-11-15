/**
 * Issue #4808 (erasure, MEDIUM; Codex G, transcribed by Claude 2): when the file store failed during a person's
 * erasure, the fallback queued their files for the daily job one path at a time, and a first queue write that failed
 * ended the loop: that path and every one after it had neither a deletion nor a queue entry, and a repeat erasure
 * could no longer find them (their records were already gone). Now every path is queued independently, a failed one is
 * tried again at once, and only a path still not queued leaves the erasure incomplete. Synthetic data only.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { reviewId, saveReview, setReviewPhoto } from "@/lib/reviews";
import { reviewPhotoPath } from "@/lib/review-photo";
import { normaliseEmail } from "@/lib/auth";

type Commands = (string | number)[][];
// The file store never answers; Resend and Stripe answer empty.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (/blob|vercel/.test(url.hostname)) throw new Error("synthetic file store outage");
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_i4808_stand_in";
  process.env.RESEND_API_KEY = "re_test_i4808_stand_in";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_synthetic_i4808_token";
  const real = redis.pipeline.bind(redis);
  const doors = (c: Commands) => c.some((x) => x[0] === "ZADD" && x[1] === "nl:tasks:doors");
  const queued = async () => ((await real([["ZRANGEBYSCORE", "nl:tasks:doors", "-inf", "+inf"]]))[0] as string[]).filter((p) => String(p).startsWith("tasks/"));

  part("The file store fails, and the first write of the cleanup queue fails too (the issue's reproduction)");
  redis.clear();
  const world = await makeWorld();
  const ana = normaliseEmail("ana@example.com");
  await seedPerson(world, ana, null);
  let failed = 0;
  redis.pipeline = (async (c: Commands) => {
    if (doors(c) && failed === 0) { failed += 1; throw new Error("synthetic redis failure on ZADD nl:tasks:doors"); }
    return real(c);
  }) as typeof redis.pipeline;
  await erasePerson(world.store, ana, { kind: "person" }).catch(() => undefined);
  redis.pipeline = real;
  is("one queue write failed", failed, 1);
  is("the file is queued for the daily job all the same", (await queued()).length > 0, true);
  const retry = await erasePerson(world.store, ana, { kind: "person" });
  is("and a repeat erasure finishes", retry.ok, true);
  is("with the file still queued for deletion", (await queued()).length > 0, true);

  part("A queue that never takes it: the erasure is never reported done");
  redis.clear();
  const world2 = await makeWorld();
  const bo = normaliseEmail("bo@example.com");
  await seedPerson(world2, bo, null);
  let tries = 0;
  redis.pipeline = (async (c: Commands) => {
    if (doors(c)) { tries += 1; throw new Error("synthetic redis failure on ZADD nl:tasks:doors"); }
    return real(c);
  }) as typeof redis.pipeline;
  const outcome = await erasePerson(world2.store, bo, { kind: "person" }).then((r) => (r.ok ? "ok" : "incomplete"), () => "threw");
  redis.pipeline = real;
  is("not done", outcome === "ok", false);
  is("each path was tried twice before giving up", tries >= 2, true);
  // Review 3rjdf (LEVE): said as incomplete, so the team's log says "not complete", never a thrown step.
  is("said as incomplete, not thrown", outcome, "incomplete");
  // Review 3rjdf (MEDIUM): the repeat erasure finds nothing through the records already deleted, so the paths are kept
  // where it reads them first, and it queues them then.
  const again = await erasePerson(world2.store, bo, { kind: "person" });
  is("a repeat erasure with the queue back finishes", again.ok, true);
  is("and the file it could not queue before is queued now", (await queued()).length > 0, true);
  part("Review 3rjdf (MEDIUM): the paths' own set, the queue and the file store all failing: nothing is deleted on a guess");
  redis.clear();
  const world3 = await makeWorld();
  const cy = normaliseEmail("cy@example.com");
  await seedPerson(world3, cy, null);
  redis.pipeline = (async (c: Commands) => {
    if (doors(c) || c.some((x) => x[0] === "SADD" && String(x[1]).startsWith("nl:erase:files:"))) throw new Error("synthetic redis failure");
    return real(c);
  }) as typeof redis.pipeline;
  const third = await erasePerson(world3.store, cy, { kind: "person" }).then((r) => (r.ok ? "ok" : "incomplete"), () => "threw");
  redis.pipeline = real;
  is("said as incomplete", third, "incomplete");
  const repeat = await erasePerson(world3.store, cy, { kind: "person" });
  is("the repeat, everything back, finishes", repeat.ok, true);
  is("and the file is queued for deletion: its record was kept until its path was", (await queued()).length > 0, true);
  is("nothing left of the paths' set once done", redis.keys().filter((k) => k.startsWith("nl:erase:files:") && JSON.stringify(redis.run(["SMEMBERS", k])) !== "[]").length, 0);
  part("Review 3rjdf (MEDIUM): a review's photo is kept before the review goes, with the set, the queue and the store failing");
  redis.clear();
  const world5 = await makeWorld();
  const eve = normaliseEmail("eve@example.com");
  await seedPerson(world5, eve, null);
  const stats5 = world5.store.statsId as string;
  const saved = await saveReview(stats5, { productId: world5.courseProduct, email: eve, reference: "cs_test_I4808Photo0001", pi: "pi_I4808Photo0001", rating: 5, text: "Synthetic words", name: "Eve" }, world5.store);
  is("a review saved", saved.state, "created");
  const photo = await reviewPhotoPath("keeper@example.com", "image/jpeg");
  is("with a photo", typeof (await setReviewPhoto(stats5, world5.courseProduct, reviewId(stats5, world5.courseProduct, eve), { path: photo, width: 1200, height: 900 })), "object");
  redis.pipeline = (async (c: Commands) => {
    if (doors(c) || c.some((x) => x[0] === "SADD" && String(x[1]).startsWith("nl:erase:files:"))) throw new Error("synthetic redis failure");
    return real(c);
  }) as typeof redis.pipeline;
  const photoFirst = await erasePerson(world5.store, eve, { kind: "person" }).then((r) => (r.ok ? "ok" : "incomplete"), () => "threw");
  redis.pipeline = real;
  is("photo: said as incomplete", photoFirst, "incomplete");
  is("photo: the repeat finishes", (await erasePerson(world5.store, eve, { kind: "person" })).ok, true);
  is("photo: and the photo is queued for deletion", ((await real([["ZRANGEBYSCORE", "nl:tasks:doors", "-inf", "+inf"]]))[0] as string[]).includes(photo), true);
  done();
}
void main().catch((error) => { console.error(error); process.exit(1); });
