/**
 * Issue #4145 (Codex U): the daily usage watch (app/api/cron/usage/route.ts) turned an inventory it could not read
 * into a legitimate zero. A failed video settlement, a failed read of the stores visited or of the stores with orders
 * each became "no store", and the run could still answer ok with HTTP 200. Each inventory is now said as unread: the
 * run still does every other part, then answers an error at the end that names the part (`unread`), never a zero.
 * Synthetic Redis only.
 */
import { GET } from "@/app/api/cron/usage/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
let failing: RegExp | null = null;
const sent: Command[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  sent.push(commands);
  if (failing && commands.some((c) => c[0] === "SMEMBERS" && failing!.test(String(c[1])))) throw new Error("the database did not answer");
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

  for (const [name, pattern, others] of [
    ["video", /watch/, [/^nl:traffic:folders:/, /^nl:orders:folders:/]],
    ["visits", /^nl:traffic:folders:/, [/watch/, /^nl:orders:folders:/]],
    ["orders", /^nl:orders:folders:/, [/watch/, /^nl:traffic:folders:/]],
  ] as [string, RegExp, RegExp[]][]) {
    part(`The ${name} inventory cannot be read: said as unread, never as zero`);
    failing = pattern;
    const got = await run();
    failing = null;
    is("the run answers an error, not ok", [got.status >= 500, got.body.ok], [true, false]);
    is(`and names the ${name} part as unread`, Array.isArray(got.body.unread) && (got.body.unread as string[]).includes(name), true);
    is("its own result says unread, never a count of zero stores", (got.body[name] as { unread?: boolean } | undefined)?.unread, true);
    is("the other parts still ran", others.every((other) => askedFor(got.from, other)), true);
  }

  part("Control: every inventory read: ok, as before");
  const fine = await run();
  is("ok, nothing unread", [fine.status, fine.body.ok, fine.body.unread ?? []], [200, true, []]);

  console.error = quiet;
  done();
}

void main();
