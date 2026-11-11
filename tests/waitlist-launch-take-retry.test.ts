/**
 * A launch deletes its waitlist once it is done (lib/waitlist.ts, takeList), and the privacy page promises it
 * ("then the waitlist's addresses are deleted"). That deletion is its own request: when it fails once (Redis
 * failing, a lost answer) or answers in an unknown shape, a later run must try it again, never leave the
 * addresses kept for good (Claude 1's review of #2576). And the launch email is not sent a second time.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, launch, runLaunches, setSoon } from "@/lib/waitlist";
import { HASH_TAKE_ALL } from "@/lib/redis-take";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const mailed: string[] = [];
let batches = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    batches += 1;
    return Response.json({ data: (JSON.parse(String(init?.body ?? "[]")) as unknown[]).map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  if (url.hostname === "api.resend.com") {
    mailed.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
/** How the next take of a waitlist goes wrong, once: a thrown failure, or an answer of another shape. */
let failNextTake: "throw" | "shape" | null = null;
redis.pipeline = (async (commands: Commands) => {
  if (failNextTake && commands.some((c) => c[0] === "EVAL" && c[1] === HASH_TAKE_ALL)) {
    const how = failNextTake;
    failNextTake = null;
    if (how === "throw") throw new Error("a stand-in for Redis failing on the waitlist's deletion");
    return ["not a list of pairs"];
  }
  return original(commands);
}) as typeof redis.pipeline;

const lastToken = () => mailed.at(-1)?.match(/token=([0-9a-f]{48})/)?.[1] ?? "";
const run = () => runLaunches(storeForHandle, readListing, Date.now() + 10_000).catch(() => -1);

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const product = async (title: string) => {
    const made = await addProduct("owner@example.com", title, "", "39", null);
    if (!made.ok) throw new Error("no product");
    const store = (await storeForEmail("owner@example.com"))!;
    await setSoon(store, made.product.id, true);
    return (await readListing(store, made.product.id))!;
  };
  let ip = 1;

  for (const how of ["throw", "shape"] as const) {
    part(`A launch whose waitlist deletion fails once (${how === "throw" ? "Redis failing" : "an answer of another shape"})`);
    const p = await product(`The ${how} Book`);
    const store = (await storeForEmail("owner@example.com"))!;
    const listKey = `nl:wl:${store.statsId}:${p.id}`;
    is("(Ana joins)", await joinWaitlist({ store, product: p, email: `ana-${how}@example.com`, consent: false, ip: `10.0.0.${ip++}`, origin: "https://marktmorgen.com" }), "sent");
    is("(and confirms)", (await confirmSpot(lastToken(), store)).ok, true);
    is("(launched to one)", await launch(store, p, { note: "Out now.", address: "1 Main St, Springfield" }), { ok: true, total: 1 });
    const before = batches;
    failNextTake = how;
    await run();
    is("(the deletion failed: the list is still there)", (await redis.pipeline([["EXISTS", listKey]]))[0], 1);
    await run();
    await run();
    is("a later run deletes the waitlist", (await redis.pipeline([["EXISTS", listKey]]))[0], 0);
    is("the launch email went out once, never again", batches - before, 1);
  }

  part("A launch with nobody confirmed, whose deletion fails once");
  const nobody = await product("The Quiet Book");
  const store = (await storeForEmail("owner@example.com"))!;
  const listKey = `nl:wl:${store.statsId}:${nobody.id}`;
  is("(Bo joins, never confirms)", await joinWaitlist({ store, product: nobody, email: "bo@example.com", consent: false, ip: `10.0.0.${ip++}`, origin: "https://marktmorgen.com" }), "sent");
  failNextTake = "throw";
  const launched = await launch(store, nobody, { note: "", address: "" }).catch(() => "threw");
  is("(launched, nobody to email, or refused for the failure)", launched === "threw" || (typeof launched === "object" && launched.ok === true), true);
  await run();
  await run();
  is("a later run deletes the waitlist", (await redis.pipeline([["EXISTS", listKey]]))[0], 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
