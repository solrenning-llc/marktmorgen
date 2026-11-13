/**
 * A person erased while a waitlist launch is being made is never written into
 * that launch afterwards.
 *
 * launch() read the list (HGETALL) and wrote the send list (RPUSH) in two
 * steps, with nothing held between them. An erasure that ran in between
 * (forgetWaitlistPerson: HDEL from the list, then blanking the send lists)
 * found no send list yet, so it blanked nothing and was reported complete.
 * The launch then wrote the erased address into the send list from the list it
 * had read before, and runLaunches emailed it. Now an address the list no
 * longer holds after the send list is written is blanked there, so either the
 * erasure's blanking or the launch's own check removes it. Synthetic records.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { forgetWaitlistPerson, launch, runLaunches, setSoon } from "@/lib/waitlist";
import { storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[] };
const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    for (const mail of batch) sent.push(...mail.to);
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "owner@example.com";
const ERASED = "dana@example.com";
const KEPT = "hal@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const added = await addProduct(OWNER, "The Bread Book", "", "39", null);
  if (!added.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, added.product.id))!;
  const sid = store.statsId!;
  await setSoon(store, product.id, true);
  const place = (i: number) => JSON.stringify({ at: 1, ok: 1, c: false, t: String(i).repeat(48) });
  await redis.pipeline([["HSET", `nl:wl:${sid}:${product.id}`, ERASED, place(1), KEPT, place(2)]]);

  // The erasure runs right after launch() has read the list, before it writes the send list.
  const real = redis.pipeline.bind(redis);
  type Command = (string | number)[];
  let erased: number | null = null;
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    if (erased === null && commands.some((c) => c[0] === "HGETALL" && c[1] === `nl:wl:${sid}:${product.id}`)
      && commands.some((c) => c[0] === "GET" && c[1] === `nl:wl:${sid}:${product.id}:job`)) {
      redis.pipeline = real;
      erased = await forgetWaitlistPerson(sid, [product.id], ERASED);
    }
    return replies;
  }) as typeof redis.pipeline;

  part("an erasure between the launch's read and its write");
  const result = await launch(store, product, { note: "", address: "1 Main St, Portland, OR 97201" });
  redis.pipeline = real;
  is("the erasure ran in between and removed the list entry", erased, 1);
  is("the launch was made", result.ok, true);
  const [list] = (await real([["LRANGE", `nl:wl:${sid}:${product.id}:send`, 0, -1]])) as [string[]];
  is("the erased address is not in the send list", list.includes(ERASED), false);
  is("the other person is still in it", list.includes(KEPT), true);

  part("the launch sends");
  for (let i = 0; i < 3; i += 1) await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
  is("the erased person gets no launch email", sent.includes(ERASED), false);
  is("the other person gets it", sent.includes(KEPT), true);
  done();
}

void main();
