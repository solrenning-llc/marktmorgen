/**
 * Issue #4145 (Codex U): the daily usage watch (app/api/cron/usage/route.ts) turned an inventory it could not read
 * into a legitimate zero. A failed video settlement, a failed read of the stores visited or of the stores with orders
 * each became "no store", and the run could still answer ok with HTTP 200. Each inventory is now said as unread: the
 * run still does every other part, then answers an error at the end that names the part (`unread`), never a zero.
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
const sent: Command[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  sent.push(commands);
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

async function run(): Promise<{ status: number; body: Record<string, unknown>; from: number }> {
  const from = sent.length;
  const response = await GET(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, from };
}

async function main(): Promise<void> {
  redis.clear();
  delete process.env.CRON_SECRET;
  const quiet = console.error;
  console.error = () => {};
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
    is("the run answers an error, not ok", [got.status >= 500, got.body.ok], [true, false]);
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
    is("the run answers an error naming the delivery part and the orders part", [got.status, got.body.ok, got.body.unread], [503, false, ["delivery", "orders"]]);
  }

  console.error = quiet;
  console.log = loud;
  done();
}

void main();
