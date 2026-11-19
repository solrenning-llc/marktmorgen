/**
 * Rule 24 for the waitlist's links (lib/waitlist.ts, joinWaitlist; Codex G,
 * 19 November 2026, MEDIUM, privacy and integrity): the confirm and leave
 * grants and their two notes for a deletion of the person go in one pipeline
 * of eight commands, and the confirmation email goes out only once every
 * reply says they are there.
 *
 * On main the pipeline's replies were not read: a cut reply ([]) wrote the
 * place and emailed a "confirm your spot" link whose token did not exist, and
 * tokens with the address could be left outside the deletion index. Now a
 * bundle not proved writes no place, sends nothing, deletes the tokens this
 * request made (an existing place keeps its own leave link) and gives back
 * the data room it took. Synthetic data only.
 */
import { claimHandle, ensureListId, ensureStatsId, storeForEmail, addProduct } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { joinWaitlist, setSoon } from "@/lib/waitlist";
import { parseEntry } from "@/lib/waitlist-rules";
import { waitlistTokenKey } from "@/lib/waitlist-tokens";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") return Response.json({ data: (JSON.parse(String(init?.body ?? "[]")) as unknown[]).map((_, i) => ({ id: `synthetic_${i}` })) });
  if (url.hostname === "api.resend.com") {
    sent.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Commands = (string | number)[][];
const isBundle = (commands: Commands) => commands.length === 8 && commands[0]?.[0] === "SET" && String(commands[0]?.[1]).startsWith("nl:wl:t:");
const tokensIn = (commands: Commands) => commands.filter((c) => c[0] === "SET").map((c) => String(c[1]));

/** Runs `run` with the link bundle answered by `reply`; `lands` writes it first (a reply lost after the write). */
async function withBundleReply<T>(reply: unknown, lands: boolean, run: () => Promise<T>): Promise<{ result: T; tokens: string[] }> {
  const original = redis.pipeline;
  const tokens: string[] = [];
  redis.pipeline = async (commands: Commands) => {
    if (isBundle(commands)) {
      tokens.push(...tokensIn(commands));
      if (lands) await original.call(redis, commands);
      if (reply === "throws-partial") {
        await original.call(redis, commands.slice(0, 2));
        throw new Error("synthetic partial bundle failure");
      }
      if (reply === "throws") throw new Error("synthetic lost link-bundle reply");
      return reply as Awaited<ReturnType<typeof original>>;
    }
    return original.call(redis, commands);
  };
  try {
    return { result: await run().catch(() => "threw" as T), tokens };
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  await claimHandle("owner@bundle.example", "bundle-books", "Bundle Books", "");
  await ensureStatsId("owner@bundle.example");
  await ensureListId("owner@bundle.example");
  const made = await addProduct("owner@bundle.example", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  let store = (await storeForEmail("owner@bundle.example"))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  store = (await storeForEmail("owner@bundle.example"))!;
  const sid = String(store.statsId);
  const listKey = `nl:wl:${sid}:${product.id}`;
  const room = () => JSON.stringify(redis.run(["HGETALL", String(dataKey(store))]));
  const exists = (key: string) => redis.run(["EXISTS", key]) === 1;
  let n = 0;
  const join = (email: string) => joinWaitlist({ store, product, email, consent: false, ip: `192.0.2.${++n}`, origin: "https://marktmorgen.com" });

  part("A bundle Redis confirmed: the place is written and its link emailed");
  let before = sent.length;
  is("joined", await join("healthy@example.com"), "sent");
  is("one confirmation email", sent.length - before, 1);

  const cases = [
    ["a cut reply ([]), nothing written", [], false],
    ["a short reply, nothing written", ["OK", "OK"], false],
    ["a refused SET, nothing written", [null, "OK", 1, 0, 1, 1, 0, 1], false],
    ["a cut reply after the bundle landed", [], true],
    ["a thrown reply before any write", "throws", false],
    ["a thrown reply after the bundle landed", "throws", true],
    ["a thrown reply after grants but before deletion notes", "throws-partial", false],
  ] as const;
  for (const [label, reply, lands] of cases) {
    part(`A new address, its link bundle answered ${label}`);
    const email = `new-${n}@example.com`;
    const roomBefore = room();
    before = sent.length;
    const { result, tokens } = await withBundleReply(reply, lands, () => join(email));
    is("not certified as sent", result, "error");
    is("no unusable confirmation email", sent.length - before, 0);
    is("no place written", redis.run(["HGET", listKey, email]), null);
    is("no token of this request is left", tokens.filter(exists), []);
    is("the data room it took is given back", room(), roomBefore);
  }

  part("An address already on the list, its link bundle cut");
  const again = "again@example.com";
  await join(again);
  const place = parseEntry(String(redis.run(["HGET", listKey, again])))!;
  const leaveKey = waitlistTokenKey(place.t);
  const placeBefore = redis.run(["HGET", listKey, again]);
  const roomBefore = room();
  before = sent.length;
  const { result, tokens } = await withBundleReply([], false, () => join(again));
  is("not certified as sent", result, "error");
  is("no unusable confirmation email", sent.length - before, 0);
  is("its place is left as it was", redis.run(["HGET", listKey, again]), placeBefore);
  is("its own link to leave is kept", exists(leaveKey), true);
  is("the new link to confirm is not left", tokens.filter((t) => t !== leaveKey).filter(exists), []);
  is("what was counted for it is given back", room(), roomBefore);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
