/**
 * 639 [GL7](25): every reading of a page has its ceiling before it costs
 * anything (lib/page-read.ts, app/api/store/read; the cost lane's finding of
 * 4 November 2026). Through the real route with the stand-in database:
 *
 *   - the same token sent twice counts once, and the repeat costs one command;
 *   - a call made by hand with a nonce the server's draw did not pick counts
 *     nothing and costs nothing, even signed;
 *   - a token older than READ_TOKEN_SECONDS counts nothing;
 *   - a store whose window of public requests is spent counts nothing, and
 *     each reading taken is one of those requests;
 *   - a drawn, good reading counts once in both records, the blocks' and the
 *     time ranges', and the store page's in the day's;
 *   - the draw is the server's: one page view in READ_SAMPLE gets a token,
 *     and the browser sends whatever it was given.
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { READ_SAMPLE, READ_TOKEN_SECONDS, STORE_SCOPE, readSampled, readToken, readTokenPass } from "@/lib/page-read";
import { readDepth } from "@/lib/page-depth";
import { readStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { allowanceWindow } from "@/lib/allowance-window";
import { deriveKey } from "@/lib/secret-box";
import { POST as readRoute } from "@/app/api/store/read/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "reader@example.com";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const PRODUCT = "prod000001";

/** How many commands were sent to the database while something ran. */
let commands = 0;
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  return real(list);
}) as typeof redis.pipeline;
async function counted(work: () => Promise<unknown>): Promise<number> {
  commands = 0;
  await work();
  return commands;
}

let seed = 0;
/** A fresh visit nonce, drawn (`yes`) or not by the server's own draw. */
function nonce(yes: boolean): string {
  for (;;) {
    const n = `visit${String((seed += 1)).padStart(11, "0")}`;
    if (readSampled(n) === yes) return n;
  }
}

const send = (body: Record<string, unknown>) =>
  readRoute(new Request("https://marktmorgen.com/api/store/read", { method: "POST", headers: { "user-agent": PHONE }, body: JSON.stringify({ h: "lantern", ...body }) }) as never);
const sale = (t: string, b = "blok0001", s: unknown = 42) => send({ t, k: "d", p: PRODUCT, b, s });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "lantern", "Lantern Books", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;

  part("The draw is the server's");
  let given = 0;
  for (let i = 0; i < 4_000; i += 1) if (readToken(statsId, PRODUCT)) given += 1;
  is("about one page view in READ_SAMPLE gets a token, the rest none", Math.abs(given / 4_000 - 1 / READ_SAMPLE) < 0.03, true);
  is("a nonce not drawn gets no token", readToken(statsId, PRODUCT, Date.now(), nonce(false)), "");
  // Signed with this deployment's own key, as only the server could: still refused, since the draw is checked again.
  const issued = Math.floor(Date.now() / 1000).toString(36);
  const undrawn = nonce(false);
  const signature = createHmac("sha256", deriveKey("page-read")!).update(`${statsId}|${PRODUCT}|${issued}|${undrawn}`).digest("base64url").slice(0, 22);
  const handMade = `${statsId}.${issued}.${undrawn}.${signature}`;
  is("a token for a nonce not drawn is refused even when signed", readTokenPass(handMade, PRODUCT), null);
  const page = readFileSync("components/page-depth.tsx", "utf8") + readFileSync("components/store-reach.tsx", "utf8");
  is("the browser no longer draws: it sends what it was given", page.includes("Math.random"), false);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the privacy policy says the server picks, the code lasts two hours and a reading counts once", privacy.includes("Our server picks one page view in eight") && privacy.includes("we keep the code for those two hours only, so the same reading is\n          never counted twice"), true);

  part("A call made by hand");
  const byHand = await counted(() => sale(handMade));
  is("counts nothing and costs no command", [(await readDepth(statsId, PRODUCT)).visitors, byHand], [0, 0]);
  const old = readToken(statsId, PRODUCT, Date.now() - (READ_TOKEN_SECONDS + 60) * 1000, nonce(true));
  is("an expired token counts nothing and costs no command", [await counted(() => sale(old)), (await readDepth(statsId, PRODUCT)).visitors], [0, 0]);
  const ahead = readToken(statsId, PRODUCT, Date.now() + 3_600_000, nonce(true));
  is("nor one dated ahead of the clock", [await counted(() => sale(ahead)), (await readDepth(statsId, PRODUCT)).visitors], [0, 0]);
  const elsewhere = await counted(() => send({ t: readToken(statsId, PRODUCT, Date.now(), nonce(true)), h: "elsewhere", k: "d", p: PRODUCT, b: "blok0001" }));
  is("nor one sent with another store's address: the mark and the read that finds no such store", [elsewhere <= 2, (await readDepth(statsId, PRODUCT)).visitors], [true, 0]);

  part("Once a visit");
  const token = readToken(statsId, PRODUCT, Date.now(), nonce(true));
  const first = await counted(() => sale(token));
  const after = await readDepth(statsId, PRODUCT);
  is("a drawn, good reading counts once in both records", [after.visitors, after.stopped, after.time], [1, { blok0001: 1 }, { "@t2": 1 }]);
  const again = await counted(() => sale(token, "blok0002", 400));
  const twice = await readDepth(statsId, PRODUCT);
  is("the same token again counts nothing, in either record", [twice.visitors, twice.stopped, twice.time], [1, { blok0001: 1 }, { "@t2": 1 }]);
  is("and costs the one command that says it was used", again, 1);
  // The most one reading counted sends, each a command of the stand-in's pipeline (a script is one):
  // the mark; the store by its address (two reads); its request and the request's expiry the first time in
  // the window; a store that pays nothing taking its place of the month the first time (lib/free-pool-rules.ts,
  // five); the count, one script, and each record's expiry the first time it is written (two).
  const MOST = 1 + 2 + 2 + 5 + 3;
  const steady = await counted(() => sale(readToken(statsId, PRODUCT, Date.now(), nonce(true)), "blok0001", 42));
  console.log(`  commands: first reading ${first}, a later one ${steady}, a repeat ${again}`);
  is("a reading counted is bounded: the mark, the store, its request and the count", [first <= MOST, steady <= 1 + 2 + 1 + 1 + 1], [true, true]);

  part("The store page, the same way");
  const reach = readToken(statsId, STORE_SCOPE, Date.now(), nonce(true));
  await send({ t: reach, k: "s", n: 1, b: "p:prod000001", c: "" });
  await send({ t: reach, k: "s", n: 2, b: "l:link01", c: "l:link01" });
  is("counted once a visit too", (await readStats(store))!.windows.d7.reach, { "1.p:prod000001>": 1 });

  part("One of the store's public requests");
  const window = allowanceWindow(store, Date.now())!;
  const requests = `nl:traffic:r:${await storeFolder(storeRef(store))}:${window.id}`;
  const before = Number(redis.run(["GET", requests]) ?? 0);
  await sale(readToken(statsId, PRODUCT, Date.now(), nonce(true)), "blok0003", 5);
  is("each reading taken is one request of the store's window", Number(redis.run(["GET", requests])) - before, 1);
  redis.run(["SET", requests, "100000000"]);
  const spent = await counted(() => sale(readToken(statsId, PRODUCT, Date.now(), nonce(true)), "blok0004", 5));
  const atLimit = await readDepth(statsId, PRODUCT);
  is("past the window nothing is counted", [atLimit.visitors, atLimit.stopped.blok0004, atLimit.time["@t0"]], [3, undefined, 1]);
  // The mark, the store, its place of the month and the request that says the window is spent: no count.
  is("and nothing is spent past the check of the window", spent <= 1 + 2 + 1 + 1, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
