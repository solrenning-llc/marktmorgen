/**
 * Issue #4145 (Codex U): the daily usage watch (app/api/cron/usage/route.ts) turned an inventory it could not read
 * into a legitimate zero. A failed video settlement, a failed read of the stores visited or of the stores with orders
 * each became "no store", and the run could still answer ok with HTTP 200. Each inventory is now said as unread: the
 * run still does every other part, then answers an error at the end that names the part (`unread`), never a zero.
 * Since then (#5466 reviews): each inventory also in another reply shape (Claude 3 ykH), never logged as "every store
 * inside" (Claude 3 ivvh); each of the three delivery reads unknown together with an inventory, both named; the last
 * answer, a store over the delivery allowance, with an inventory unread; the two reads of the watched stores, the
 * settlement's and the notices', failed apart; every error answer never kept by a cache (Claude 3 xvBY8).
 * Synthetic Redis only.
 */
import { GET } from "@/app/api/cron/usage/route";
import { DELIVERY_ALLOWANCE_BYTES, recordDelivery, rememberFolderOwner } from "@/lib/delivery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
let failing: RegExp | null = null;
/** "throw": the database does not answer; "shape": it answers the inventory in another shape (Claude 3 ykH on #5466). */
let how: "throw" | "shape" = "throw";
/** A delivery read that does not answer, with an inventory unread too (Claude 3 xvBY8 on #5466). */
let deliveryFailing: { command: string; key: RegExp } | null = null;
/**
 * Only some reads of one inventory fail, by their order in the run (1 is the first), so the two reads of the watched
 * stores, the settlement's and the notices', are failed apart (Claude 3 xvBY8 on #5466).
 */
let only: { pattern: RegExp; first: number; last: number } | null = null;
let seenOnly = 0;
const sent: Command[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  sent.push(commands);
  if (only && commands.some((c) => c[0] === "SMEMBERS" && only!.pattern.test(String(c[1])))) {
    seenOnly += 1;
    if (seenOnly >= only.first && seenOnly <= only.last) throw new Error("the database did not answer");
  }
  if (deliveryFailing && commands.some((c) => c[0] === deliveryFailing!.command && deliveryFailing!.key.test(String(c[1])))) {
    throw new Error("the database did not answer");
  }
  if (failing && commands.some((c) => c[0] === "SMEMBERS" && failing!.test(String(c[1])))) {
    if (how === "throw") throw new Error("the database did not answer");
    return commands.map((c) => (c[0] === "SMEMBERS" && failing!.test(String(c[1])) ? 7 : null));
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof GET>[0];
const askedFor = (from: number, pattern: RegExp) => sent.slice(from).some((commands) => commands.some((c) => c[0] === "SMEMBERS" && pattern.test(String(c[1]))));

/** What the run wrote to the error log, by its first words. */
const errors: string[] = [];
async function run(): Promise<{ status: number; body: Record<string, unknown>; from: number; cache: string | null }> {
  const from = sent.length;
  seenOnly = 0;
  errors.length = 0;
  const response = await GET(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, from, cache: response.headers.get("cache-control") };
}

async function main(): Promise<void> {
  redis.clear();
  delete process.env.CRON_SECRET;
  const quiet = console.error;
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
  // What the run says in its log (Claude 3 ivvh on #5466): an unread part is never logged as "every store inside".
  const loud = console.log;
  const logged: string[] = [];
  console.log = (...parts: unknown[]) => {
    const line = parts.map(String).join(" ");
    if (/^[a-z]+-watch: /.test(line)) logged.push(line);
    else loud(...parts);
  };

  for (const [name, pattern, others, mode] of ([
    ["video", /watch/, [/^nl:traffic:folders:/, /^nl:orders:folders:/]],
    ["visits", /^nl:traffic:folders:/, [/watch/, /^nl:orders:folders:/]],
    ["orders", /^nl:orders:folders:/, [/watch/, /^nl:traffic:folders:/]],
  ] as [string, RegExp, RegExp[]][]).flatMap(([n, p, o]) => (["throw", "shape"] as const).map((m) => [n, p, o, m] as const))) {
    part(`The ${name} inventory ${mode === "throw" ? "cannot be read" : "is answered in another shape"}: said as unread, never as zero`);
    failing = pattern;
    how = mode;
    logged.length = 0;
    const got = await run();
    failing = null;
    is("the run answers an error, not ok, never kept by a cache", [got.status >= 500, got.body.ok, got.cache], [true, false, "no-store"]);
    is(`and names the ${name} part as unread`, Array.isArray(got.body.unread) && (got.body.unread as string[]).includes(name), true);
    is("its own result says unread, never a count of zero stores", (got.body[name] as { unread?: boolean } | undefined)?.unread, true);
    is("the other parts still ran", others.every((other) => askedFor(got.from, other)), true);
    is(`the log never says every store is inside for the ${name} part`, logged.some((line) => line.startsWith(`${name}-watch: every store inside`)), false);
  }

  part("Control: every inventory read: ok, as before");
  const fine = await run();
  is("ok, nothing unread", [fine.status, fine.body.ok, fine.body.unread ?? []], [200, true, []]);

  // Each of the three delivery reads unknown while an inventory is unread too (Claude 3 xvBY8 on #5466): the error names
  // both parts, never the delivery part alone. One store over the allowance, so the run reaches the told and owner reads.
  const heavy = "c0c0c0c0c0c0c0c0";
  await rememberFolderOwner(heavy, "heavy@example.com");
  await recordDelivery(`stores/${heavy}/prod01/file.zip`, DELIVERY_ALLOWANCE_BYTES + 1024);
  for (const [read, command, key] of [
    ["the stores over the delivery allowance", "SMEMBERS", /^nl:store:delivery:over:/],
    ["who was already told", "GET", /^nl:usage-watch:told:/],
    ["whose the stores over it are", "GET", /^nl:store:folder-owner:/],
  ] as [string, string, RegExp][]) {
    part(`The orders inventory unread and ${read} unknown: both named`);
    failing = /^nl:orders:folders:/;
    how = "throw";
    deliveryFailing = { command, key };
    const got = await run();
    failing = null;
    deliveryFailing = null;
    is("the run answers an error naming the delivery part and the orders part, never kept by a cache", [got.status, got.body.ok, got.body.unread, got.cache], [503, false, ["delivery", "orders"], "no-store"]);
  }

  // The run's last answer (a store over the delivery allowance, written to this run) with an inventory unread (Claude 3
  // xvBY8 on #5466): still the error naming the part, never ok. The store's owner is read; the told list is new.
  part("A store over the delivery allowance and the orders inventory unread: the last answer names the part");
  {
    await redis.pipeline([["DEL", `nl:usage-watch:told:${new Date().toISOString().slice(0, 7)}`]]);
    failing = /^nl:orders:folders:/;
    how = "throw";
    const got = await run();
    failing = null;
    is("the run reached its last answer (the owners were read)", "unreadOwners" in got.body, true);
    is("which names the orders part as unread, an error, never kept by a cache", [got.status, got.body.ok, got.body.unread, got.cache], [503, false, ["orders"], "no-store"]);
  }

  // The two reads of the watched stores failed apart (Claude 3 xvBY8 on #5466): the settlement's, then the notices'.
  part("Only the video settlement's read fails: the video part is unread, and the notices still read their stores");
  {
    only = { pattern: /watch/, first: 1, last: 1 };
    const got = await run();
    only = null;
    is("the settlement's failure is what was logged, not the notices'",
      [errors.some((e) => e.startsWith("settling video hours failed")), errors.some((e) => e.startsWith("could not read the stores whose video was watched"))], [true, false]);
    is("the run answers an error naming the video part", [got.status, (got.body.unread as string[] | undefined)?.includes("video"), (got.body.video as { unread?: boolean }).unread], [503, true, true]);
    is("the notices still read the watched stores after it", askedFor(got.from, /watch/) && seenOnly > 1, true);
  }
  part("Only the notices' read of the watched stores fails: the video part is unread, the settlement ran");
  {
    // How many reads the settlement makes before the notices', counted on a run where none fails.
    let from = 0;
    for (let n = 2; n <= 12 && !from; n += 1) {
      only = { pattern: /watch/, first: n, last: 99 };
      await run();
      only = null;
      if (!errors.some((e) => e.startsWith("settling video hours failed")) && errors.some((e) => e.startsWith("could not read the stores whose video was watched"))) from = n;
    }
    is("a read past the settlement's can be failed alone", from > 1, true);
    only = { pattern: /watch/, first: from, last: 99 };
    const got = await run();
    only = null;
    is("the notices' failure is what was logged, not the settlement's",
      [errors.some((e) => e.startsWith("settling video hours failed")), errors.some((e) => e.startsWith("could not read the stores whose video was watched"))], [false, true]);
    is("the run answers an error naming the video part", [got.status, (got.body.unread as string[] | undefined)?.includes("video"), (got.body.video as { unread?: boolean }).unread], [503, true, true]);
  }

  console.error = quiet;
  console.log = loud;
  done();
}

void main();
