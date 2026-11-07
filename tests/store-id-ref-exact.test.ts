/**
 * Two MEDIUMs on #2878 (rule 24):
 *
 *   A. Claude 5 (head db06fae8): storeForId sent any non-empty value of
 *      "nl:store:id:<id>" to storeForEmail. A value cut short ("ana@exam",
 *      "#" and five letters) or text that is no reference at all read another
 *      owner key, got nil and answered null: "no store", which callers act on
 *      (the PayPal settle set, plan disputes, the numbers link). Only nil at the
 *      id key, or nil at the owner key of a well-formed reference, is no store;
 *      any other value, and a record whose id is not the one asked, is unknown.
 *   C. Codex U (review on 97abb22d): app/l/[code] turned an unknown store read
 *      into "this link has ended", a 302 to /l/ended that the CDN may keep for
 *      five minutes. Unknown is now a 503 kept by nobody (private, no-store),
 *      and the same link opens the store again once the read is healthy.
 *
 * Synthetic only: the Redis stub.
 */
import { GET as openShortLink } from "@/app/l/[code]/route";
import { addLink } from "@/lib/short-links";
import { claimHandle, createStore, ensureStatsId, storeForEmail, storeForId } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
/** Every GET of `key` answers `value` while `body` runs. */
async function getAnswers<T>(key: string, value: unknown, body: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    const answer = await real(commands);
    return answer.map((v, i) => (commands[i]?.[0] === "GET" && commands[i]?.[1] === key ? value : v));
  }) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return value === null ? "null" : typeof value === "object" ? "store" : String(value);
  } catch (error) {
    return (error as Error).name;
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "down" }), { status: 500 })) as typeof fetch;

  part("A. storeForId: a value at the id key that is not this store's reference is unknown");
  redis.clear();
  const made = await claimHandle("ana@example.com", "anashop", "Shop", "");
  if (!made.ok) throw new Error(`not made: ${made.reason}`);
  const ana = made.store;
  const extraMade = await createStore("ana@example.com", "anaextra", "Extra", "");
  if (!extraMade.ok) throw new Error("extra store not made");
  const extra = extraMade.store;
  is("control: both found on a healthy read", [(await storeForId(ana.sid))?.sid, (await storeForId(extra.sid))?.sid], [ana.sid, extra.sid]);
  for (const [label, sid, value] of [
    ["the first store, its address cut ('ana@exam')", ana.sid, "ana@exam"],
    ["the first store, text that is no reference", ana.sid, '{"x":1}'],
    ["the first store, a space inside", ana.sid, "ana @example.com"],
    ["the extra store, '#' and five letters", extra.sid, `#${extra.sid.slice(0, 5)}`],
    ["the extra store, another store's '#' reference", extra.sid, `#${"f".repeat(extra.sid.length)}`],
  ] as [string, string, string][]) {
    is(`${label}: unknown, never no store`, await outcome(() => getAnswers(`nl:store:id:${sid}`, value, () => storeForId(sid))), "UnknownReplyError");
  }
  is(
    "the extra store's id pointing at the first store's address (another id): unknown",
    await outcome(() => getAnswers(`nl:store:id:${extra.sid}`, "ana@example.com", () => storeForId(extra.sid))),
    "UnknownReplyError",
  );
  is(
    "a well-formed address with no store kept there: no store",
    await outcome(() => getAnswers(`nl:store:id:${ana.sid}`, "nobody@example.com", () => storeForId(ana.sid))),
    "null",
  );
  await real([["DEL", `nl:store:id:${ana.sid}`]]);
  is("control: nil at the id key is no store", await outcome(() => storeForId(ana.sid)), "null");

  part("C. A short link whose store cannot be read: 503, kept by nobody, never 'ended'");
  redis.clear();
  const beaMade = await claimHandle("bea@example.com", "beashop", "Bea", "");
  if (!beaMade.ok) throw new Error("bea not made");
  await ensureStatsId("bea@example.com");
  const bea = (await storeForEmail("bea@example.com"))!;
  const added = await addLink({ sid: bea.sid, statsId: bea.statsId! }, { name: "launch post", place: "instagram", target: { kind: "store" } }, () => false);
  if (!added.ok) throw new Error(`no link: ${added.reason}`);
  const code = added.link.code;
  const open = (c: string) => openShortLink(new Request(`https://marktmorgen.com/l/${c}`) as never, { params: Promise.resolve({ code: c }) });
  const healthy = await open(code);
  is("control: a healthy link opens the store", [healthy.status, String(healthy.headers.get("location")).includes("/l/ended")], [302, false]);
  const ownerOf = await real([["GET", `nl:store:id:${bea.sid}`]]);
  is("the store's id key reads its owner", ownerOf[0], "bea@example.com");
  const { createHash } = await import("node:crypto");
  const ownerKey = `nl:store:owner:${createHash("sha256").update("nimbus-store:bea@example.com").digest("hex").slice(0, 40)}`;
  for (const [label, value] of [["text that is not JSON", "{cut"], ["a number", 42]] as [string, unknown][]) {
    const answer = await getAnswers(ownerKey, value, () => open(code));
    is(`the store's record is ${label}: 503, no redirect`, [answer.status, answer.headers.get("location")], [503, null]);
    is(`the store's record is ${label}: kept by no cache`, answer.headers.get("cache-control"), "private, no-store");
  }
  const cut = await getAnswers(`nl:store:id:${bea.sid}`, "bea@exa", () => open(code));
  is("the store's id key cut short: 503, never 'ended'", [cut.status, cut.headers.get("location")], [503, null]);
  const again = await open(code);
  is("control: once the read is healthy the same link opens the store", [again.status, String(again.headers.get("location")).includes("/l/ended")], [302, false]);
  const missing = await open("zzzzzzz");
  is("control: a link that never was still says ended", [missing.status, String(missing.headers.get("location")).endsWith("/l/ended")], [302, true]);
  done();
}

void main();
