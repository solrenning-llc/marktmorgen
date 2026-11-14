/**
 * A launch whose read of the waitlist or of its job comes back in another
 * shape changes nothing (Claude 4's sweep, C4-2910, sweepA7 P4). Before, an
 * unknown list read as nobody waiting: the product left "coming soon", the
 * whole list was deleted with its room, and nobody got the email. An unknown
 * job read as no launch running, so a second launch could start over one
 * still sending. Now either throws UnknownReply before any write, and the
 * list, the mark and the job stay as they were.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { isSoon, launch, setSoon, waitlistViews } from "@/lib/waitlist";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
const ADDRESS = "1 Main St, Portland, OR 97201";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_launch_unknown_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const made = await addProduct("owner@example.com", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  // Two confirmed places, as joinWaitlist and confirmSpot leave them (lib/waitlist-rules.ts WaitEntry).
  for (const [i, email] of ["dana@example.com", "hal@example.com"].entries()) {
    await redis.pipeline([["HSET", `nl:wl:${store.statsId}:${product.id}`, email, JSON.stringify({ at: 1, ok: 1, c: false, t: String(i).repeat(48) })]]);
  }
  const before = (await waitlistViews(store, [product.id]))[product.id];
  is("two confirmed and waiting", [before.confirmed, before.soon], [2, true]);

  const pipe = redis.pipeline.bind(redis);
  /** Replaces the launch's first read (GET of the job and HGETALL of the list) with `shape(real)`. */
  const answering = (shape: (real: unknown[]) => unknown) => {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipe(commands);
      return commands.length === 2 && commands[0][0] === "GET" && commands[1][0] === "HGETALL" ? shape(replies as unknown[]) : replies;
    }) as typeof redis.pipeline;
  };
  const shapes: [string, (real: unknown[]) => unknown][] = [
    ["the list's reply missing", ([j]) => [j, undefined]],
    ["the list as a number", ([j]) => [j, 7]],
    ["the list of odd length", ([j, l]) => [j, [...(l as unknown[]), "extra"]]],
    ["the list holding something that is not text", ([j, l]) => [j, [...(l as unknown[]).slice(0, -1), 5]]],
    ["one reply instead of two", ([j]) => [j]],
    ["the job's reply missing", ([, l]) => [undefined, l]],
    ["the job as text that is not a job", ([, l]) => ["{not json", l]],
    ["a running job read as a number", ([, l]) => [42, l]],
  ];
  for (const [label, shape] of shapes) {
    part(label);
    answering(shape);
    const answer = await launch(store, product, { note: "Thanks for waiting.", address: ADDRESS }).then((r) => JSON.stringify(r), (e: Error) => e.name);
    redis.pipeline = pipe;
    is(`${label}: the launch is refused as unknown`, answer, "UnknownReply");
    const after = (await waitlistViews(store, [product.id]))[product.id];
    is(`${label}: still coming soon, both still waiting, no launch`, [after.soon, after.confirmed, after.launch], [true, 2, null]);
    is(`${label}: still marked`, await isSoon(store, product.id), true);
  }

  part("A known list still launches");
  const launched = await launch(store, product, { note: "Thanks for waiting.", address: ADDRESS });
  is("both are to be emailed", launched, { ok: true, total: 2 });
  done();
}

void main();
