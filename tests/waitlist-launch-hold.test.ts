/**
 * A waitlist launch whose job, store or listing cannot be read waits for the
 * next run; it is never dropped from the job queue (rule 24).
 *
 * runLaunches read three things before sending: the launch job, the store
 * behind its handle (storeForHandle) and the product's listing (readListing).
 * Each came back null when Redis answered in another shape, and a null was
 * taken as "gone": the launch was taken off nl:wl:jobs for good. Nobody after
 * the cursor got the one email the waitlist promised, and the list and send
 * keys were never deleted, so their addresses stayed stored. Now an unknown
 * read holds the launch where it is (nothing reserved, nothing sent) and the
 * next run, once the read is known, sends to everyone once. Only an exact
 * answer that it is gone (Redis's own nil, a free handle, a product the store
 * no longer has) finishes it as before.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, removeProduct, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { launch, runLaunches, setSoon, waitlistViews } from "@/lib/waitlist";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { withinOneUtcDay } from "./one-utc-day";

// The launches' sends are counted in the month the clock is in; a real month end passing mid-file moved the code to
// the next month's counts while the checks still expected the first one's. The clock stays inside one UTC day
// (tests/one-utc-day.ts).
withinOneUtcDay();

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
const OWNER = "owner@example.com";
const JOBS = "nl:wl:jobs";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const current = async () => (await storeForEmail(OWNER))!;
  let made = 0;
  const newProduct = async () => {
    made += 1;
    const added = await addProduct(OWNER, `The Bread Book ${made}`, "", "39", null);
    if (!added.ok) throw new Error("no product");
    return (await readListing(await current(), added.product.id))!;
  };
  const people = ["dana@example.com", "hal@example.com"];
  const place = (i: number) => JSON.stringify({ at: 1, ok: 1, c: false, t: String(i).repeat(48) });

  const real = redis.pipeline.bind(redis);
  type Command = (string | number)[];
  /** Every pipeline whose first command `matches` is answered with `shape(real replies)`; everything else as it is. */
  const bend = (matches: (command: Command) => boolean, shape: (replies: unknown[]) => unknown) => {
    redis.pipeline = (async (commands: Command[]) => {
      const replies = await real(commands);
      return commands[0] && matches(commands[0]) ? shape(replies) : replies;
    }) as typeof redis.pipeline;
  };
  const restore = () => {
    redis.pipeline = real;
  };
  const inJobs = async (sid: string, pid: string) => (await real([["SISMEMBER", JOBS, `${sid}|${pid}`]]))[0];

  /** A product of its own, launched for both people, its job waiting at the start. */
  const launched = async (label: string, product?: Awaited<ReturnType<typeof newProduct>>) => {
    const item = product ?? (await newProduct());
    const store = await current();
    const list = `nl:wl:${store.statsId}:${item.id}`;
    await setSoon(store, item.id, true);
    for (const [i, email] of people.entries()) await real([["HSET", list, email, place(i)]]);
    const started = await launch(store, item, { note: "", address: ADDRESS });
    is(`(${label}) launched for both`, started.ok && started.total, 2);
    return { store, product: item, sid: store.statsId!, pid: item.id };
  };

  const shapes: [string, (replies: unknown[]) => unknown][] = [
    ["no reply in its slot", () => [undefined]],
    ["a number", () => [42]],
    ["a string cut short", () => ["{cut"]],
    ["a pipeline with no reply", () => []],
  ];

  /** The first run reads `what` in another shape and holds; the next run, read as it is, sends to both once. */
  const holds = async (what: string, matches: (pid: string) => (command: Command) => boolean, product?: () => Promise<Awaited<ReturnType<typeof newProduct>>>) => {
    for (const [label, shape] of shapes) {
      const name = `${what}: ${label}`;
      batches.length = 0;
      const { store, sid, pid } = await launched(name, product ? await product() : undefined);
      bend(matches(pid), shape);
      const first = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
      restore();
      const view = (await waitlistViews(store, [pid]))[pid];
      is(`(${name}) nobody emailed while the read is unknown`, [first, batches.flat().length], [0, 0]);
      is(`(${name}) the launch stays queued, at the start, with its list`, [await inJobs(sid, pid), view.launch?.cursor, Boolean(view.launch?.finished), view.confirmed], [1, 0, false, 2]);
      const second = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
      is(`(${name}) the next run sends to both, once`, [second, batches.flat().map((m) => m.to[0]).sort()], [2, people]);
      is(`(${name}) and then it is done and off the queue`, await inJobs(sid, pid), 0);
    }
  };

  part("The job's own read in another shape: the launch waits");
  await holds("job", (pid) => (command) => command[0] === "GET" && typeof command[1] === "string" && command[1].endsWith(`:${pid}:job`));

  part("The store's read in another shape: the launch waits");
  await holds("store", () => (command) => command[0] === "GET" && command[1] === "nl:store:handle:harbor");

  part("The listing's read in another shape: the launch waits");
  /** A product past the store's first page, so its listing is read from its own record, not the store record. */
  const offHead = async () => {
    // A new product goes after the others: once the first page is full, the next one is past it.
    let item = await newProduct();
    for (let i = 0; i < 30 && (await current()).catalog.head.some((l) => l.id === item.id); i += 1) item = await newProduct();
    is("the product's listing is read from its own record", (await current()).catalog.head.some((l) => l.id === item.id), false);
    return item;
  };
  await holds("listing", (pid) => (command) => command[0] === "GET" && typeof command[1] === "string" && command[1].startsWith("nl:catalog:") && command[1].endsWith(`:l:${pid}`), offHead);

  part("What is gone, exactly, is still finished as before");
  {
    batches.length = 0;
    const { sid, pid } = await launched("job gone");
    await real([["DEL", `nl:wl:${sid}:${pid}:job`]]);
    const sent = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
    is("(job gone: Redis's own nil) off the queue, nobody emailed", [await inJobs(sid, pid), sent, batches.flat().length], [0, 0, 0]);
  }
  {
    batches.length = 0;
    const { sid, pid } = await launched("store gone");
    // The handle leads nowhere: Redis answers its own nil.
    bend((command) => command[0] === "GET" && command[1] === "nl:store:handle:harbor", () => [null]);
    const sent = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
    restore();
    is("(store gone: its handle is free) off the queue, nobody emailed", [await inJobs(sid, pid), sent, batches.flat().length], [0, 0, 0]);
  }
  {
    batches.length = 0;
    const { sid, pid } = await launched("listing gone", await offHead());
    const removed = await removeProduct(OWNER, pid);
    is("(listing gone) the product was removed", removed.ok, true);
    const sent = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
    is("(listing gone: the store no longer has it) off the queue, nobody emailed", [await inJobs(sid, pid), sent, batches.flat().length], [0, 0, 0]);
  }
}

main()
  .then(done)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
