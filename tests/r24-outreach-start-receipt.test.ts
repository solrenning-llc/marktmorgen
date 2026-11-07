/**
 * Claude 1's focal on #2870 (rule 30, same file, same shape): a new draft is said written only on its exact receipt.
 * Before, startPitch ignored the reply of its one write (HSET pitch, INCR/EXPIRE day, SET stop link, HDEL/DEL of a
 * replaced draft) and answered ok:true, so the studio showed a draft whose footer's stop link may not open (the
 * business's opt-out could not be pressed), with no wait held before the next pitch to that business. saveSender
 * (LOW) answered the sender saved on an unknown SET reply. Synthetic data only; the model is a stand-in fetch.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { type PageReader, linkKey, listPitches, saveSender, startPitch } from "@/lib/outreach";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  const text = '{"subject": "A recipe video with your pans", "body": "Hi,\\n\\nI post three family recipes a week.\\n\\nWould a recipe video with your pans be of interest?"}';
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}) as typeof fetch;

const NOW = Math.floor(Date.now() / 1000) - 86_400;
const SENDER = { name: "Jenny Park", address: "PO Box 12, Columbus, OH 43004, USA" };
const INPUT = { goal: "sponsor" as const, country: "US", isCompany: false, page: "https://copperoak.com/partners", email: "partnerships@copperoak.com", company: "Copper & Oak", about: "Pans.", notes: "Recipes." };
const reader = (async (url: string) =>
  url === "https://copperoak.com/partners" ? { url, html: "<p>Creators: write to partnerships@copperoak.com</p>" } : null) as PageReader;

let n = 0;
async function fresh() {
  redis.clear();
  n += 1;
  const email = `start-owner-${n}@example.com`;
  const made = await claimHandle(email, `start-harbor-${n}`, "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(email);
  await setSubscription(email, { customerId: `cus_Start0000${n}`, subscriptionId: `sub_Start0000${n}`, active: true, tier: "pro", trialEnds: 0, period: paidPeriod(Date.now(), { behind: 30, ahead: 300 }) });
  const store = (await storeForEmail(email))!;
  await saveSender(store, SENDER);
  return store;
}

const real = redis.pipeline.bind(redis);
type Command = (string | number)[];
/** The first pipeline `match` picks is answered `reply` (its commands not run); the rest run for real. */
function answer(match: (commands: Command[]) => boolean, reply: unknown[]) {
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!used && match(commands)) {
      used = true;
      return [...reply];
    }
    return real(commands);
  }) as typeof redis.pipeline;
}
const restore = () => { redis.pipeline = real; };
const isDraftWrite = (commands: Command[]) => commands[0]?.[0] === "HSET" && commands.some((c) => c[0] === "INCR");
const isSenderWrite = (commands: Command[]) => commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).endsWith(":me");

for (const [label, reply] of [["no receipt", []], ["a receipt in another shape", ["QUEUED", "QUEUED", "QUEUED", "QUEUED"]], ["a stop link not set", [1, 1, 1, null]]] as const) {
  test(`startPitch: ${label} is never a draft said written`, async () => {
    const store = await fresh();
    answer(isDraftWrite, [...reply]);
    let result: unknown = "threw";
    try {
      result = await startPitch(store, INPUT, { reader, now: NOW }).catch(() => "threw");
    } finally { restore(); }
    assert.equal(result, "threw", "answered ok:true on an unknown receipt");
  });
}

test("healthy control: a draft written is kept and its stop link opens", async () => {
  const store = await fresh();
  const result = await startPitch(store, INPUT, { reader, now: NOW });
  if (!result.ok) throw new Error(`not written: ${result.reason}`);
  assert.deepEqual((await listPitches(store)).map((p) => p.id), [result.pitch.id]);
  assert.notEqual(redis.run(["GET", linkKey(result.pitch.stop)]), null);
});

test("saveSender: no receipt is never said saved", async () => {
  const store = await fresh();
  answer(isSenderWrite, []);
  try {
    await assert.rejects(() => saveSender(store, { name: "Dana Lee", address: "PO Box 9, Columbus, OH 43004, USA" }));
  } finally { restore(); }
});

test("saveSender healthy control: saved", async () => {
  const store = await fresh();
  assert.deepEqual(await saveSender(store, SENDER), SENDER);
});
