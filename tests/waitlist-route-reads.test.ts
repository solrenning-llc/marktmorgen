/**
 * #5010 row 149 (sweep 2f36, zz-env-c-waitlist): the studio's waitlist switches (app/api/store/waitlist: "soon" on and
 * off, and "launch") read the product's whole list to draw its view, and a launch read it once more to start the email.
 * At MAX_WAITLIST places that is megabytes on one studio request, whose own price moves PAGE_INCLUDED_BYTES
 * (lib/sent-bytes.ts). The view needs two counts and the launch needs only how many it starts and the addresses moved
 * onto its send list, which never have to leave the database.
 *
 * Measured here end to end, every reply the route reads from Redis by its bytes, at the worst list: MAX_WAITLIST places
 * of the longest address a place can hold (MAX_EMAIL_LENGTH), half of them confirmed. Each switch, the work it leaves
 * for after its answer included (the pre-orders it hands over), reads within one studio request's included bytes.
 * The results stay exactly what they were: the counts, the launch's total and its send list, sorted.
 * Synthetic store; in-memory Redis; no network.
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { MAX_EMAIL_LENGTH, SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { LAUNCH_PLACE_MOST_BYTES, WAITLIST_COUNT, WAITLIST_COUNT_CALLS, launchReadMostBytes, setSoon, waitlistViews } from "@/lib/waitlist";
import { allowanceUsed, forceAllowance, giveAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { MAX_WAITLIST } from "@/lib/waitlist-rules";
import { PAGE_INCLUDED_BYTES } from "@/lib/sent-bytes";
import { POST as waitlistRoute } from "@/app/api/store/waitlist/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** Bytes of every reply read from Redis while counting (a reply's JSON, as it crosses the wire). */
let counting = false;
let readBytes = 0;
redis.pipeline = (async (batch: Command[]) => {
  const answers = await real(batch);
  if (counting) readBytes += Buffer.byteLength(JSON.stringify(answers ?? null), "utf8");
  return answers;
}) as typeof redis.pipeline;

globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** The longest address a place can hold, made unique by its number. */
const address = (n: number) => {
  const tail = `${n}@example.com`;
  return `${"a".repeat(MAX_EMAIL_LENGTH - tail.length)}${tail}`;
};
const token = (n: number) => `t${String(n).padStart(42, "0")}`;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_reads";
  const owner = "wl-reads-owner@example.com";
  await claimHandle(owner, "wlreads", "WL Reads", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  const made = await addProduct(owner, "The Soon Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  const list = `nl:wl:${store.statsId}:${product.id}`;
  const send = `${list}:send`;

  // The worst list: every place the list may hold, the longest addresses, every other one confirmed.
  const confirmed: string[] = [];
  const fields: string[] = [];
  for (let n = 0; n < MAX_WAITLIST; n += 1) {
    const ok = n % 2 === 0 ? 1_790_000_000_000 + n : 0;
    if (ok) confirmed.push(address(n));
    fields.push(address(n), JSON.stringify({ at: 1_790_000_000_000, ok, c: true, k: true, t: token(n), w: 1 }));
  }
  for (let i = 0; i < fields.length; i += 2_000) await real([["HSET", list, ...fields.slice(i, i + 2_000)]]);
  confirmed.sort();
  const listBytes = Buffer.byteLength(JSON.stringify(fields), "utf8");
  is("the worst list is far past one studio request's included bytes", listBytes > 20 * PAGE_INCLUDED_BYTES, true);

  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    afterTasks.length = 0;
    readBytes = 0;
    counting = true;
    const response = await waitlistRoute(new NextRequest("https://marktmorgen.com/api/store/waitlist", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ id: product.id, ...body }) }));
    const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; view?: { soon?: boolean; confirmed?: number; waiting?: number; launch?: { total?: number } | null } };
    // The work the route left for after its answer (the pre-orders it hands over) is paid by the same request.
    for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
    counting = false;
    return { status: response.status, answer, bytes: readBytes };
  };

  part("Coming soon on: the view's counts, read within the request's included bytes");
  await setSoon(store, product.id, false);
  const on = await post({ action: "soon", on: true });
  is("saved, with its view", [on.status, on.answer.ok, on.answer.view?.soon], [200, true, true]);
  is("the view counts the confirmed and the waiting exactly", [on.answer.view?.confirmed, on.answer.view?.waiting], [MAX_WAITLIST / 2, MAX_WAITLIST / 2]);
  is(`read within ${PAGE_INCLUDED_BYTES} bytes (read ${on.bytes})`, on.bytes <= PAGE_INCLUDED_BYTES, true);

  part("Coming soon off: the same, and its pre-orders handed over after the answer");
  const off = await post({ action: "soon", on: false });
  is("saved, with its view", [off.status, off.answer.ok, off.answer.view?.soon], [200, true, false]);
  is("the view counts the confirmed and the waiting exactly", [off.answer.view?.confirmed, off.answer.view?.waiting], [MAX_WAITLIST / 2, MAX_WAITLIST / 2]);
  is(`read within ${PAGE_INCLUDED_BYTES} bytes (read ${off.bytes})`, off.bytes <= PAGE_INCLUDED_BYTES, true);

  part("Launch without the studio requests its read takes: refused before anything is read or written");
  await setSoon(store, product.id, true);
  const NOTE = { action: "launch", note: "It is here.", address: "1 Main St, Springfield, IL 62701" };
  const fresh = async () => (await storeForEmail(owner))!;
  const most = Math.ceil((await launchReadMostBytes(store, product.id)) / PAGE_INCLUDED_BYTES);
  is("the worst list's launch takes studio requests for its read", most > 1, true);
  // Leave the guard's own request and one fewer than the launch's read takes.
  const limit = allowanceFor(await fresh(), "studio");
  const spent = limit - (await allowanceUsed(await fresh(), "studio")) - 1 - (most - 1);
  if (spent > 0) await forceAllowance(await fresh(), "studio", spent);
  const short = await post(NOTE);
  is("refused as the studio's requests used up, with the words that say so", [short.status, short.answer.error, typeof (short.answer as { message?: unknown }).message], [429, "studio_used", "string"]);
  is("nothing read past the list's size", short.bytes <= PAGE_INCLUDED_BYTES, true);
  is("still coming soon, no launch, no send list", [(await waitlistViews(store, [product.id]))[product.id]?.soon, (await waitlistViews(store, [product.id]))[product.id]?.launch, await real([["EXISTS", send]]).then((r) => r[0])], [true, null, 0]);
  if (spent > 0) await giveAllowance(await fresh(), "studio", spent);

  part("Launch: the send list holds every confirmed address, sorted, and its read is paid for");
  const before = await allowanceUsed(await fresh(), "studio");
  const launched = await post(NOTE);
  const paid = (await allowanceUsed(await fresh(), "studio")) - before;
  is("launched, its total the confirmed places", [launched.status, launched.answer.ok, launched.answer.view?.launch?.total], [200, true, MAX_WAITLIST / 2]);
  is("the send list is every confirmed address, sorted", JSON.stringify(await real([["LRANGE", send, 0, -1]]).then((r) => r[0])), JSON.stringify(confirmed));
  // The list read once, not twice (the view after it counts in the database), every byte past the request's own paid.
  is(`the list is read once (read ${launched.bytes}, the list ${listBytes})`, launched.bytes < 1.1 * listBytes, true);
  is(`every byte past the request's own is paid, one studio request each ${PAGE_INCLUDED_BYTES} (paid ${paid})`, (paid - 1) * PAGE_INCLUDED_BYTES >= launched.bytes - PAGE_INCLUDED_BYTES, true);
  is(`the bound held before the read covers it: a place at most ${LAUNCH_PLACE_MOST_BYTES} bytes`, listBytes / MAX_WAITLIST <= LAUNCH_PLACE_MOST_BYTES, true);

  part("The count is one script and the calls it is billed for");
  is("WAITLIST_COUNT makes exactly WAITLIST_COUNT_CALLS redis.call", (WAITLIST_COUNT.match(/redis\.call\(/g) ?? []).length, WAITLIST_COUNT_CALLS);

  part("Control: the studio's own read of the views counts the same");
  const views = await waitlistViews(store, [product.id]);
  is("confirmed and waiting, as the route answered", [views[product.id]?.confirmed, views[product.id]?.waiting], [MAX_WAITLIST / 2, MAX_WAITLIST / 2]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
