/**
 * Two waitlist reads that answer in another shape (rule 24): an unknown reply
 * is never "this person left the list" or "this person is on no list".
 *
 * 1. The launch email (runLaunches): its read of the next hundred places
 *    (HMGET) came back in another shape, and every address in the batch was
 *    read as having left: nobody in it was emailed, the cursor moved past
 *    them, and the list was deleted. The one email the waitlist promises was
 *    lost for them. Now the batch waits for the next run, as it does when the
 *    sender asks to retry, and goes out whole once the read is known.
 * 2. The copy of a person's data (waitlistPlacesOf, lib/person-copy.ts): a
 *    place whose read came back in another shape was left out, so the copy
 *    said "on no waitlist". Now the read fails, and the copy says it could
 *    not be made.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { launch, runLaunches, setSoon, waitlistPlacesOf, waitlistViews } from "@/lib/waitlist";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[] };
const batches: Sent[][] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    batches.push(batch);
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ADDRESS = "1 Main St, Portland, OR 97201";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const newProduct = async (title: string) => {
    const made = await addProduct("owner@example.com", title, "", "39", null);
    if (!made.ok) throw new Error("no product");
    return (await readListing((await storeForEmail("owner@example.com"))!, made.product.id))!;
  };
  const store = (await storeForEmail("owner@example.com"))!;
  const people = ["dana@example.com", "hal@example.com"];
  const place = (i: number) => JSON.stringify({ at: 1, ok: 1, c: false, t: String(i).repeat(48) });

  const real = redis.pipeline.bind(redis);
  /** Answers the first command named `name` with `shape(real reply)`; everything else as it is. */
  const answering = (name: string, shape: (reply: unknown) => unknown) => {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await real(commands);
      return commands[0]?.[0] === name ? [shape(replies[0]), ...replies.slice(1)] : replies;
    }) as typeof redis.pipeline;
  };
  const restore = () => {
    redis.pipeline = real;
  };
  const load = async () => (await storeForEmail("owner@example.com"))!;

  const shapes: [string, (reply: unknown) => unknown][] = [
    ["no reply at all", () => undefined],
    ["not a list", () => "OK"],
    ["one place short", (reply) => (Array.isArray(reply) ? reply.slice(0, 1) : reply)],
    ["a place that is a number", (reply) => (Array.isArray(reply) ? [reply[0], 7] : reply)],
  ];

  part("The launch email: an unknown read of the batch never skips anyone");
  for (const [n, [label, shape]] of shapes.entries()) {
    batches.length = 0;
    // A product of its own each time, so one case's job never stands in another's way.
    const product = await newProduct(`The Bread Book ${n + 1}`);
    const list = `nl:wl:${store.statsId}:${product.id}`;
    await setSoon(store, product.id, true);
    for (const [i, email] of people.entries()) await redis.pipeline([["HSET", list, email, place(i)]]);
    const launched = await launch(store, product, { note: "", address: ADDRESS });
    is(`(${label}) launched for both`, launched.ok && launched.total, 2);
    answering("HMGET", shape);
    const first = await runLaunches(load, readListing, Date.now() + 10_000);
    restore();
    const view = (await waitlistViews(store, [product.id]))[product.id];
    is(`(${label}) nobody emailed while the batch is unknown`, [first, batches.flat().length], [0, 0]);
    is(`(${label}) nobody passed over: the job waits at the start, the list is kept`, [view.launch?.cursor, Boolean(view.launch?.finished), view.confirmed], [0, false, 2]);
    const second = await runLaunches(load, readListing, Date.now() + 10_000);
    is(`(${label}) the next run sends to both, once`, [second, batches.flat().map((m) => m.to[0]).sort()], [2, people]);
  }

  part("The copy of a person's data: an unknown read is never 'on no waitlist'");
  const product = await newProduct("The Rye Book");
  const list = `nl:wl:${store.statsId}:${product.id}`;
  await redis.pipeline([["DEL", list], ["HSET", list, "dana@example.com", place(0)]]);
  is("read as it is, the place is in the copy", (await waitlistPlacesOf(store.statsId, [product.id], "dana@example.com")).length, 1);
  for (const [label, shape] of [
    ["no reply at all", () => undefined],
    ["a number", () => 1],
    ["a list", () => ["x"]],
  ] as [string, (reply: unknown) => unknown][]) {
    answering("HGET", shape);
    const read = await waitlistPlacesOf(store.statsId, [product.id], "dana@example.com").then(
      (places) => `read: ${places.length} place(s)`,
      () => "could not be read",
    );
    restore();
    is(`(${label}) the copy says it could not be read`, read, "could not be read");
  }
  answering("HGET", () => null);
  is("a confirmed none (null) is still none", (await waitlistPlacesOf(store.statsId, [product.id], "dana@example.com")).length, 0);
  restore();
  // A pipeline that answered fewer replies than the products asked about.
  redis.pipeline = (async (commands: (string | number)[][]) => (await real(commands)).slice(0, 1)) as typeof redis.pipeline;
  const short = await waitlistPlacesOf(store.statsId, [product.id, "other"], "dana@example.com").then(
    () => "read",
    () => "could not be read",
  );
  restore();
  is("a reply short for the products asked about is unknown", short, "could not be read");
}

main()
  .then(done)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
