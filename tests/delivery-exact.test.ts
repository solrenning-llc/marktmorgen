/**
 * Whose a folder is, read exactly (lib/delivery.ts, CX-123 rule 24).
 *
 * storeKeysOf and ownersOf read the folder's owner key with GET. Nil is a
 * folder nobody uploaded to through the studio (null, as before), and a
 * string is what was kept. Any other answer (a missing or extra reply, a
 * number, an empty string, a database that does not answer) is unknown and
 * throws: it is never "no store" or "no address on file". The daily usage
 * watch then writes to nobody about the delivery allowance, tells support no
 * false "we have no address", leaves its told list as it was and says the
 * part is unknown (503, unread ["delivery"]).
 *
 * Synthetic data only; the healthy and confirmed-absence answers work as before.
 */
import { DELIVERY_ALLOWANCE_BYTES, ownersOf, recordDelivery, rememberFolderOwner, storeKeysOf } from "@/lib/delivery";
import { GET as usage } from "@/app/api/cron/usage/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
delete process.env.CRON_SECRET;

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    sent.push(Array.isArray(body.to) ? body.to[0] : String(body.to));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
let inject: ((commands: Command[]) => Promise<unknown[]> | null) | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => inject?.(commands) ?? pipeline(commands)) as typeof redis.pipeline;
const onOwner = (commands: Command[]) => commands.length > 0 && commands.every((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:folder-owner:"));

const MALFORMED: [string, (n: number) => Promise<unknown[]>][] = [
  ["no reply at all", async () => []],
  ["a reply short", async (n) => Array(n - 1).fill("owner@example.com")],
  ["an extra reply", async (n) => [...Array(n).fill("owner@example.com"), "owner@example.com"]],
  ["undefined", async (n) => Array(n).fill(undefined)],
  ["a number", async (n) => Array(n).fill(1)],
  ["an empty string", async (n) => Array(n).fill("")],
  ["a database that does not answer", async () => { throw new Error("the database did not answer"); }],
];

async function readers(): Promise<void> {
  const a = "a0a0a0a0a0a0a0a0", b = "b0b0b0b0b0b0b0b0";
  await rememberFolderOwner(a, "Owner@Example.com");

  part("Healthy and confirmed absence: as before");
  is("storeKeysOf: a kept owner, and a folder nobody uploaded to", await storeKeysOf([a, b]), ["owner@example.com", null]);
  is("ownersOf: a kept owner, and a folder nobody uploaded to", await ownersOf([a, b]), ["owner@example.com", null]);

  part("Any other answer is unknown, never \"no store\" or \"no address\"");
  for (const [label, reply] of MALFORMED) {
    inject = (commands) => (onOwner(commands) ? reply(commands.length) : null);
    is(`storeKeysOf, answered ${label}: unknown`, await storeKeysOf([a, b]).then(() => "answered", () => "unknown"), "unknown");
    is(`ownersOf, answered ${label}: unknown`, await ownersOf([a, b]).then(() => "answered", () => "unknown"), "unknown");
    inject = null;
  }
}

async function watch(): Promise<void> {
  const folder = "c0c0c0c0c0c0c0c0";
  await rememberFolderOwner(folder, "heavy@example.com");
  await recordDelivery(`stores/${folder}/prod01/file.zip`, DELIVERY_ALLOWANCE_BYTES + 1024);
  const TOLD = "nl:usage-watch:told";
  const run = async () => {
    // Each run starts from a month where nobody was told yet.
    await pipeline([["DEL", TOLD]]);
    const before = sent.length;
    const response = await usage({ headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof usage>[0]).catch(() => null);
    const body = response ? ((await response.json()) as { unread?: string[] }) : {};
    const [told] = await pipeline([["GET", TOLD]]);
    return { status: response?.status ?? -1, unread: body.unread ?? [], emails: sent.slice(before), told };
  };

  part("Usage watch: an owner that cannot be read is never \"no address on file\"");
  for (const [label, reply] of MALFORMED) {
    inject = (commands) => (onOwner(commands) ? reply(commands.length) : null);
    is(`owner answered ${label}: nobody written to, support told nothing, the told list left, the part unknown`, await run(), { status: 503, unread: ["delivery"], emails: [], told: null });
    inject = null;
  }
  is("owner read: the owner is told, once", await run(), { status: 200, unread: [], emails: ["heavy@example.com"], told: JSON.stringify([folder]) });
}

async function main(): Promise<void> {
  redis.clear();
  await readers();
  await watch();
  done();
}

void main();
