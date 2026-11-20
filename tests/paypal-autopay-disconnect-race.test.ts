/**
 * Paying affiliates through the creator's own PayPal app (lib/paypal-payouts.ts): turning automatic payouts on or off
 * (setAutoPay) read the app's record and wrote it back whole. A disconnect (disconnectPayPal, which deletes the
 * record) that landed between that read and that write was undone: the app, with its sealed secret, was written back,
 * and with automatic payouts on, the daily run went on paying affiliates from a PayPal app its creator had removed.
 * Now the write goes only onto a record still there (SET XX), its reply read exactly; a record gone meanwhile stays
 * gone and the switch answers "not connected". Synthetic Redis only; PayPal is never called.
 */
import { disconnectPayPal, setAutoPay } from "@/lib/paypal-payouts";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("PayPal must not be called");
}) as typeof fetch;

async function main() {
  const email = "autopay-race@example.com";
  await claimHandle(email, "autopayrace", "A store", "");
  await ensureStatsId(email);
  const store = (await storeForEmail(email))!;
  const key = `nl:pp:${store.statsId}`;
  const link = JSON.stringify({ client: "AppClientSynthetic01", secret: "sealed-synthetic", at: 1, auto: false });
  const read = async () => (await redis.pipeline([["GET", key]]))[0];

  part("Healthy control: the switch is written on the app's record");
  await redis.pipeline([["SET", key, link]]);
  is("turned on", await setAutoPay(store, true), true);
  is("the record says so", JSON.parse(String(await read())).auto, true);

  part("A disconnect between the switch's read and its write is not undone");
  await redis.pipeline([["SET", key, link]]);
  const pipeline = redis.pipeline.bind(redis);
  let armed = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await pipeline(commands);
    if (armed && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key) {
      armed = false;
      await disconnectPayPal(store);
    }
    return answer;
  }) as typeof redis.pipeline;
  let said: boolean;
  try {
    said = await setAutoPay(store, true);
  } finally {
    redis.pipeline = pipeline;
  }
  is("the app stays removed", await read(), null);
  is("the switch says it is not connected", said, false);

  // Codex X8 on #4345 (ALTO, money; RETIDO in #4821, 6923303295): SET XX proves only that some record is there, not
  // that it is the one read. An app replaced between the read and the write was overwritten by the old one's record,
  // with automatic payouts on, and the daily run paid affiliates from the app the creator had removed.
  part("An app replaced between the switch's read and its write is not overwritten");
  const appB = JSON.stringify({ client: "AppClientSyntheticB2", secret: "sealed-synthetic-b", at: 2, auto: false });
  await redis.pipeline([["SET", key, link]]);
  let swap = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await pipeline(commands);
    if (swap && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key) {
      swap = false;
      await pipeline([["SET", key, appB]]);
    }
    return answer;
  }) as typeof redis.pipeline;
  let saidB: boolean;
  try {
    saidB = await setAutoPay(store, true);
  } finally {
    redis.pipeline = pipeline;
  }
  is("the new app's record stays exactly as it was written", await read(), appB);
  is("the switch says it did not switch: changed meanwhile, try again", saidB, false);
  done();
}

void main();
