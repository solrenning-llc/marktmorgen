/**
 * The daily usage watch tells each store past the delivery allowance once (Claude 7's cron hunt).
 *
 * app/api/cron/usage took no run lock and wrote its told list (then nl:usage-watch:told, now the month's own nl:usage-watch:told:YYYY-MM) once, at the end, from what it
 * read at the start. Two runs at once (a retried invocation, a manual run beside the scheduled one) both read nobody
 * told and both wrote to every owner; and a run stopped after writing to some owners (the function's time limit, a
 * crash) left the list as it was, so the next day wrote to them again. The run now holds a lock, as the other
 * scheduled jobs do, and the told list takes each owner before their notice goes out (Codex L on #4529).
 *
 * Synthetic stores and addresses; Resend is a stand-in that keeps who was written to; real MemoryRedis.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DELIVERY_ALLOWANCE_BYTES, monthKey, recordDelivery, rememberFolderOwner } from "@/lib/delivery";
import { GET as usage } from "@/app/api/cron/usage/route";
import { store as redis } from "./redis-stub";

process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
delete process.env.CRON_SECRET;

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string };
    // Only the allowance notices, by owner.
    if (String(body.subject ?? "").startsWith("Your store has sent out")) sent.push(Array.isArray(body.to) ? body.to[0] : String(body.to));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
// The month's own told list (#4502): one list per calendar month.
const TOLD = `nl:usage-watch:told:${monthKey()}`;
const A = "a1a1a1a1a1a1a1a1", B = "b1b1b1b1b1b1b1b1";
const real = redis.pipeline.bind(redis);
const run = () => usage({ headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof usage>[0]);
const quiet = async <T>(work: () => Promise<T>): Promise<T> => {
  const errors = console.error;
  console.error = () => {};
  try { return await work(); } finally { console.error = errors; }
};

async function twoStoresOver(): Promise<void> {
  redis.clear();
  sent.length = 0;
  for (const [folder, owner] of [[A, "heavy-a@example.com"], [B, "heavy-b@example.com"]] as const) {
    await rememberFolderOwner(folder, owner);
    await recordDelivery(`stores/${folder}/prod01/file.zip`, DELIVERY_ALLOWANCE_BYTES + 1024);
  }
}
const count = (to: string) => sent.filter((address) => address === to).length;

test("two runs at once write to each owner once", async () => {
  await twoStoresOver();
  await quiet(() => Promise.all([run(), run()]));
  assert.equal(count("heavy-a@example.com"), 1);
  assert.equal(count("heavy-b@example.com"), 1);
});

test("a run stopped after writing to one owner does not write to them again the next run", async () => {
  await twoStoresOver();
  // The run is stopped (as by its time limit) once it has written to the first owner: any write of the told list
  // that names the second store never happens.
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.some((c) => c[0] === "SET" && c[1] === TOLD && String(c[2]).includes(B))) throw new Error("the function was stopped");
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await quiet(() => run().catch(() => null));
  } finally {
    redis.pipeline = real;
  }
  // Since Codex L's MEDIUM on #4529 the store goes on the told list before its notice: the write that names the
  // second store is the one that is stopped, so its notice never goes out in that run.
  assert.equal(sent.length, 1, "the first owner was written to before the stop, the second was not");
  await quiet(() => run());
  assert.equal(count("heavy-a@example.com"), 1, "the first owner, recorded as told, is not written to again");
  // The second owner is written to by the next run, once: no notice is sent twice.
  assert.equal(count("heavy-b@example.com"), 1);
});
