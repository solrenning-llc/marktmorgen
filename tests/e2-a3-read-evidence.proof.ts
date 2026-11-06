/** E2 A3, evidence only: a saved opt-out must survive an unreadable membership reply. */
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { heardOff, recordHeard, setHeardOff } from "@/lib/heard";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "e2-a3-proof@example.com";
const HANDLE = "e2a3proof";
const OFF = "nl:heard:off";
const NOW = Date.now();
const realPipeline = redis.pipeline.bind(redis);
let providerReads = 0;
let sequence = 0;
process.env.STRIPE_SECRET_KEY = "sk_test_e2_a3_synthetic_only";

// No real network: only the normal paid-session response reaches the real Stripe reader.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.stripe.com" || !url.pathname.startsWith("/v1/checkout/sessions/")) {
    throw new Error("unexpected synthetic-provider request");
  }
  providerReads += 1;
  return new Response(JSON.stringify({
    id: url.pathname.split("/").at(-1), status: "complete", payment_status: "paid",
    amount_total: 4900, currency: "usd", created: Math.floor(NOW / 1000) - 60,
    metadata: { store: HANDLE, product: "prod000001" },
  }));
}) as typeof fetch;

const order = () => `cs_test_e2a3${String(++sequence).padStart(12, "0")}`;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Synthetic proof shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_E2A3Test", true);
  const shop = (await storeForEmail(OWNER))!;
  const day = `nl:stats:${shop.statsId}:${new Date(NOW).toISOString().slice(0, 10)}`;
  const counts = async () => (await realPipeline([["HMGET", day, "h:friend", "hc:friend"]]))[0];

  part("Healthy saved off/on controls, using the real reader, recorder and counters");
  await setHeardOff(HANDLE, true);
  is("confirmed one is off", await heardOff(HANDLE), true);
  const before = providerReads;
  is("saved off stops before provider lookup and counting", [await recordHeard(shop, order(), "friend", NOW), providerReads - before, await counts()], ["off", 0, [null, null]]);
  await setHeardOff(HANDLE, false);
  is("confirmed zero is on", await heardOff(HANDLE), false);
  is("healthy enabled flow counts the real answer and amount", [await recordHeard(shop, order(), "friend", NOW), await counts()], ["counted", ["1", "4900"]]);
  await setHeardOff(HANDLE, true);

  part("Only the SISMEMBER reply changes; saved off, session, claim and counters remain real");
  const cases: [string, unknown][] = [
    ["empty envelope", []],
    ["null instead of membership", [null]],
    ["boolean instead of membership", [false]],
    ["string instead of membership", ["0"]],
    ["unknown membership plus extra reply", [null, 0]],
  ];
  for (const [name, reply] of cases) {
    const session = order();
    const previous = await counts();
    const readsBefore = providerReads;
    let faults = 0;
    redis.pipeline = (async (commands) => {
      if (commands.length === 1 && commands[0][0] === "SISMEMBER" && commands[0][1] === OFF) {
        faults += 1;
        // The real store remains off. Replace this read's transport answer only.
        await realPipeline(commands);
        return reply;
      }
      return realPipeline(commands);
    }) as typeof redis.pipeline;
    let outcome: string;
    try {
      outcome = await recordHeard(shop, session, "friend", NOW).catch(() => "threw");
    } finally {
      redis.pipeline = realPipeline;
    }
    is(`${name}: exactly one targeted read; opt-out remains saved`, [faults, (await realPipeline([["SISMEMBER", OFF, HANDLE]]))[0]], [1, 1]);
    is(`${name}: unknown must not read the provider, claim or count`, [outcome!, providerReads - readsBefore, await counts(), (await realPipeline([["GET", `nl:heard:done:${session}`]]))[0]], ["unavailable", 0, previous, null]);
    is(`${name}: next healthy request respects the same saved off`, await recordHeard(shop, session, "friend", NOW), "off");
  }
  done();
}

void main();
