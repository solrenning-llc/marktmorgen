/**
 * Whether a creator turned "Where did you hear about us?" off is read exactly
 * (CX-123 rule 24), like weeklyOff in lib/stats-report.ts: 0 means asking, 1
 * means off, and a reply in any other shape means "off" (the buyer is not asked
 * on a question we cannot tell the creator wanted) and is said in the log.
 * Since finding 5 of the handles audit the switch is read in one SMISMEMBER, by
 * the store's id and the addresses it owns (lib/store-stop.ts): one 0 or 1 a
 * member, so a store with no id and no older address is asked about one member.
 * Synthetic data only, and no request ever leaves the process: fetch, sockets
 * and TLS are refused and recorded, so a regression that reaches Stripe fails
 * here instead of calling the real API (Claude 6 on #3115).
 */
import { strict as assert } from "node:assert";
import net from "node:net";
import tls from "node:tls";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import { heardOff, recordHeard, setHeardOff } from "@/lib/heard";
import { claimHandle, ensureStatsId, setStripeAccount } from "@/lib/store";
import { POST as heardRoute } from "@/app/api/store/heard/route";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_heard_off_exact_only";

const outbound: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  outbound.push(`fetch ${input instanceof Request ? input.url : String(input)}`);
  throw new TypeError("heard-off-exact: the network is closed to this test");
}) as typeof fetch;
net.Socket.prototype.connect = function (...args: unknown[]) {
  outbound.push(`socket ${JSON.stringify(args[0])}`);
  throw new Error("heard-off-exact: sockets are closed to this test");
} as typeof net.Socket.prototype.connect;
(tls as { connect: unknown }).connect = (...args: unknown[]) => {
  outbound.push(`tls ${JSON.stringify(args[0])}`);
  throw new Error("heard-off-exact: TLS is closed to this test");
};
after(() => assert.deepEqual(outbound, [], "no request left the process"));

const MALFORMED: [string, unknown[]][] = [
  ["no reply at all", []],
  ["undefined", [undefined]],
  ["null", [null]],
  ["QUEUED", ["QUEUED"]],
  ["the string 1", ["1"]],
  ["the string 0", ["0"]],
  ["two replies", [0, 0]],
  ["a negative count", [-1]],
  ["a count of two", [2]],
  ["a fraction", [0.5]],
  ["an object", [{}]],
  ["a flag of 2", [[2]]],
  ["a flag as text", [["1"]]],
  ["two flags for one member", [[0, 0]]],
  ["no flags", [[]]],
];

/** A store with no id yet and no older address: its switch is read under one member, its address. */
const HARBOR = { handle: "harbor", sid: "", previousHandles: [] };

async function withReply<T>(reply: unknown[], run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "SMISMEMBER" ? reply : original(commands))) as typeof redis.pipeline;
  try { return await run(); } finally { redis.pipeline = original; }
}

async function logged<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { return { value: await run(), lines }; } finally { console.error = original; }
}

for (const [label, reply] of MALFORMED) {
  test(`heardOff: ${label} is off (not asked) and is logged`, async () => {
    const { value, lines } = await logged(() => withReply(reply, () => heardOff(HARBOR)));
    assert.equal(value, true);
    assert.ok(lines.some((l) => l.includes("heard-off")), "the unknown reply is said in the log");
  });
}

// Not read is not "off" (Claude 6 on #3115): the answer is not counted now and the reply says so honestly.
for (const [label, reply] of MALFORMED) {
  test(`recordHeard: ${label} counts nothing and is unavailable, not off`, async () => {
    const store = { ...HARBOR, stripeAccountId: "acct_1TestHeardOff01", statsId: "synthetic-stats", currency: "usd" } as unknown as Parameters<typeof recordHeard>[0];
    const { value } = await logged(() => withReply(reply, () => recordHeard(store, "cs_test_heardoff00001", "friend")));
    assert.deepEqual(outbound, [], "Stripe is never asked when the mark cannot be read");
    assert.equal(value, "unavailable");
  });
}

const OWNER = "heard-off-exact@example.com";
async function postAnswer(reply: unknown[]): Promise<{ status: number; body: unknown }> {
  redis.clear();
  await claimHandle(OWNER, "harborx", "Harbor Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHeardOff02", true);
  const request = new NextRequest("https://marktmorgen.com/api/store/heard", {
    method: "POST",
    headers: { "content-type": "application/json", host: "marktmorgen.com", origin: "https://marktmorgen.com" },
    body: JSON.stringify({ h: "harborx", s: "cs_test_heardoff00002", a: "friend" }),
  });
  const response = await logged(() => withReply(reply, () => heardRoute(request)));
  return { status: response.value.status, body: await response.value.json() };
}

test("the route answers an unknown reply with 503 unavailable, never 200 off", async () => {
  assert.deepEqual(await postAnswer(["QUEUED"]), { status: 503, body: { ok: false } });
  assert.deepEqual(outbound, [], "Stripe is never asked when the mark cannot be read");
});

test("the route control: a store confirmed off still answers 200 without counting", async () => {
  // The store has an id and its address: one flag for each, the id's set.
  assert.deepEqual(await postAnswer([[1, 0]]), { status: 200, body: { ok: false } });
  assert.deepEqual(outbound, []);
});

test("healthy controls: on by default, off once switched off, on again, and nothing is logged", async () => {
  redis.clear();
  const { value, lines } = await logged(async () => {
    const out = [await heardOff(HARBOR)];
    await setHeardOff(HARBOR, true);
    out.push(await heardOff(HARBOR));
    await setHeardOff(HARBOR, false);
    out.push(await heardOff(HARBOR));
    return out;
  });
  assert.deepEqual(value, [false, true, false]);
  assert.deepEqual(lines, []);
});

test("confirmed replies 0 and 1 are read as before", async () => {
  assert.equal(await withReply([[0]], () => heardOff(HARBOR)), false);
  assert.equal(await withReply([[1]], () => heardOff(HARBOR)), true);
});
