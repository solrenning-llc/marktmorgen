/**
 * A deletion link asked from one store's page (askErasureLink with a handle)
 * is never answered "sent" with nothing made because that store could not be
 * read just now (review of #2970, MEDIUM, rule 24/30). The store is read
 * before anything about the address, so an error here tells nothing about who
 * buys there: it reaches the route's own catch (status=error). A store that
 * truly is not there still answers "sent", as before.
 */
import { askErasureLink } from "@/lib/erasure-request";
import { claimHandle, ensureStoreId } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;

/** Runs `work` with the pipeline that GETs a key starting with `prefix` answered by `reply` (or throwing). */
async function answering<T>(prefix: string, reply: unknown[] | "throw", work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (!commands.some((command) => command[0] === "GET" && String(command[1] ?? "").startsWith(prefix))) return original.call(redis, commands);
    if (reply === "throw") throw new Error("connection reset");
    return [...reply];
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function outcome(work: () => Promise<{ status: string }>): Promise<string> {
  try {
    return (await work()).status;
  } catch (error) {
    return error instanceof Error && error.name !== "Error" ? `threw ${error.name}` : "threw";
  }
}

let n = 0;
const ask = (handle: string) => askErasureLink({ email: `buyer${(n += 1)}@example.com`, ip: `203.0.113.${n}`, origin: "https://marktmorgen.com", handle });

async function main(): Promise<void> {
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_ask_unread_only_a_stand_in";
  redis.clear();
  if (!(await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await ensureStoreId("owner@example.com");

  part("Controls");
  is("a store that reads: sent", await outcome(() => ask("harbor")), "sent");
  is("a store that is not there: sent, as before", await outcome(() => ask("nosuchstore")), "sent");
  is("a handle that was let go: sent, as before", await outcome(() => answering("nl:store:handle:", ["released:1"], () => ask("harbor"))), "sent");

  part("A store that could not be read is never answered 'sent' with nothing made");
  for (const [name, prefix, reply] of [
    ["the handle read throws", "nl:store:handle:", "throw"],
    ["the handle: no reply", "nl:store:handle:", []],
    ["the handle: a number", "nl:store:handle:", [42]],
    ["the store's record: a number", "nl:store:owner:", [7]],
  ] as const) {
    const got = await outcome(() => answering(prefix, reply === "throw" ? "throw" : [...reply], () => ask("harbor")));
    is(`${name}: it throws, so the route answers status=error`, got.startsWith("threw"), true);
  }
  is("control: read again, sent", await outcome(() => ask("harbor")), "sent");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
