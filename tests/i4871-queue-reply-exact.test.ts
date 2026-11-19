/**
 * #4871, Codex X7 (MEDIUM, privacy): when the file store failed, a person's erasure handed each file to the daily job
 * with noteTaskUpload, whose ZADD reply was never read. A reply that did not read was taken as queued: the kept path
 * was let go and the erasure said done, with the file neither deleted nor queued. Now only one reply, an exact 0 or
 * 1, is queued; anything else throws UnknownReplyError, so the path stays kept and the erasure is incomplete for the
 * repeat. Synthetic Redis and a synthetic fetch only (the file store never answers); fictional addresses.
 */
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { erasePerson } from "@/lib/person-erasure";
import { noteTaskUpload } from "@/lib/assignment";
import { UnknownReplyError } from "@/lib/redis-reply";
import { normaliseEmail } from "@/lib/auth";

type Commands = (string | number)[][];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (/blob|vercel/.test(url.hostname)) throw new Error("synthetic file store outage");
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
const isDoors = (c: Commands) => c.length === 1 && c[0]?.[0] === "ZADD" && c[0]?.[1] === "nl:tasks:doors";

async function noted(reply: unknown[]): Promise<string> {
  redis.pipeline = (async (c: Commands) => (isDoors(c) ? reply : real(c))) as typeof redis.pipeline;
  try {
    await noteTaskUpload("stores/s/tasks/c/l/w/file.pdf", 0);
    return "queued";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_i4871_stand_in";
  process.env.RESEND_API_KEY = "re_test_i4871_stand_in";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_synthetic_i4871_token";

  part("noteTaskUpload: only an exact 0 or 1 is queued");
  is("1 (listed anew) is queued", await noted([1]), "queued");
  is("0 (listed already) is queued", await noted([0]), "queued");
  for (const [what, reply] of [["no reply", []], ["null", [null]], ["text", ["1"]], ["2 for one member", [2]], ["-1", [-1]], ["an extra reply", [1, 0]]] as [string, unknown[]][]) {
    is(`${what}: unknown`, await noted(reply), "unknown");
  }

  part("The erasure: a queue reply that does not read keeps the path and is never done");
  redis.clear();
  const world = await makeWorld();
  const ada = normaliseEmail("ada-4871@example.com");
  await seedPerson(world, ada, null);
  let unread = 0;
  redis.pipeline = (async (c: Commands) => {
    if (isDoors(c)) { unread += 1; return [null]; }
    return real(c);
  }) as typeof redis.pipeline;
  const first = await erasePerson(world.store, ada, { kind: "person" }).then((r) => (r.ok ? "ok" : "incomplete"), () => "threw");
  redis.pipeline = real;
  is("the queue answered something unreadable", unread > 0, true);
  is("the erasure is incomplete, never done", first, "incomplete");
  const kept = redis.keys().filter((k) => k.startsWith("nl:erase:files:") && (redis.run(["SMEMBERS", k]) as string[]).length > 0);
  is("the path is still kept for the repeat", kept.length, 1);
  const again = await erasePerson(world.store, ada, { kind: "person" });
  is("with the queue back, the repeat finishes", again.ok, true);
  const doors = (await real([["ZRANGEBYSCORE", "nl:tasks:doors", "-inf", "+inf"]]))[0] as string[];
  is("and the file is queued for deletion", doors.some((p) => String(p).startsWith("tasks/") || String(p).startsWith("stores/")), true);

  // Codex L on #4871 @68949841c3 (MEDIUM): the kept paths are the last reference to the files once the records that
  // named them are gone, so they must not expire while neither the deletion nor the cleanup queue confirmed taking them.
  part("Kept paths outlive any wait: a repeat a month later still finds the file and queues it before saying done");
  redis.clear();
  const late = await makeWorld();
  const bea = normaliseEmail("bea-4871@example.com");
  await seedPerson(late, bea, null);
  redis.pipeline = (async (c: Commands) => (isDoors(c) ? [null] : real(c))) as typeof redis.pipeline;
  const before = await erasePerson(late.store, bea, { kind: "person" }).then((r) => (r.ok ? "ok" : "incomplete"), () => "threw");
  redis.pipeline = real;
  is("first: incomplete, the path kept", before, "incomplete");
  advance(31 * 86_400 * 1000);
  const kept31 = redis.keys().filter((k) => k.startsWith("nl:erase:files:") && (redis.run(["SMEMBERS", k]) as string[]).length > 0);
  is("a month later the path is still kept", kept31.length, 1);
  const repeat = await erasePerson(late.store, bea, { kind: "person" });
  const queuedNow = ((await real([["ZRANGEBYSCORE", "nl:tasks:doors", "-inf", "+inf"]]))[0] as string[]).some((p) => String(p).startsWith("tasks/") || String(p).startsWith("stores/"));
  is("the repeat finishes only with the file queued for deletion", [repeat.ok, queuedNow], [true, true]);
  done();
}

void main().catch((error) => { console.error(error); process.exit(1); });
