/**
 * The payday job never takes or keeps a store's month for a store whose erasure began while it was reading the
 * book (Codex L-20261119-1144, #5010 row 88). The month's claim nl:aff:payday:<statsId>:<month> is a key of the
 * store's own family (lib/data-families.ts, "nl:aff:payday:": E): a plain SET NX taken after the slow book and PayPal
 * reads, or the SET EX that keepMonth writes when its EXPIRE finds nothing, would write it back after the closing walk
 * passed it, and a run that took it would go on to the email (and, for a store that pays by itself, the press).
 * The claim is taken through claimWhileStoreLive and the keep's fallback through setWhileStoreLive
 * (lib/store-live-cache.ts): "gone" means nothing is written, nothing is sent and nobody is paid.
 *
 * A store kept from before ids is fenced by its record and statsId; that path is tested in the fence's own tests
 * (claimWhileStoreLive, setWhileStoreLive), since the job reads its stores from Redis, where claimHandle gives each one an id.
 *
 * Synthetic store, affiliate and sale; Resend is a stand-in that counts what was sent; MemoryRedis.
 */
import { mock } from "node:test";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { sendPaydayEmails } from "@/lib/affiliate-payday";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, setAffiliateSetting, setStripeAccount, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = new Date(Date.UTC(2026, 10, 15, 14));
mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
process.env.STRIPE_SECRET_KEY = "sk_test_payday_erasure_fence_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

let sent = 0;
/** Run once, inside the Resend call, while the job still holds the old Store. */
let duringEmail: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const step = duringEmail;
    duringEmail = null;
    if (step) await step();
    sent += 1;
    return new Response(JSON.stringify({ id: `email_${sent}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const DAY = 86_400;
const T0 = Math.floor(NOW.getTime() / 1000) - 400 * DAY;
const MONTH = "2026-11";

async function seed(owner: string, handle: string): Promise<Store & { statsId: string }> {
  redis.clear();
  sent = 0;
  duringEmail = null;
  await claimHandle(owner, handle, "Payday Fence", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestPaydayFence");
  await setAffiliateSetting(owner, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, payday: 15 }));
  const store = (await storeForEmail(owner))! as Store & { statsId: string };
  const aff = "b2b2b2b2b2b2";
  await redis.pipeline([
    ["HSET", `nl:aff:${store.statsId}:people`, aff, JSON.stringify({ id: aff, email: `${aff}@example.com`, code: "b2b2b", status: "approved", appliedAt: T0 * 1000, decidedAt: T0 * 1000, note: "" })],
    ["HSET", `nl:aff:${store.statsId}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff, at: T0 + 10 * DAY, product: "prod01", title: "Bread course", base: 1000, total: 1000, currency: "usd", rate: 20, self: false, how: "click" })],
  ]);
  return store;
}

const claimKey = (statsId: string) => `nl:aff:payday:${statsId}:${MONTH}`;
const claimExists = (statsId: string) => Number(redis.run(["EXISTS", claimKey(statsId)])) === 1;

/** The erasure's first fenced step: the erasing mark, and (for a store with an id) its id key gone. */
async function beginErasure(store: Store, dropId: boolean): Promise<void> {
  const commands: (string | number)[][] = [["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]];
  if (dropId && store.sid) commands.push(["DEL", storeIdCommand(store.sid)[1]]);
  await redis.pipeline(commands);
}

/** Runs `step` once, just before the first command that touches the month's claim key is sent. */
function beforeClaim(statsId: string, step: () => Promise<void>): () => void {
  const real = redis.pipeline.bind(redis);
  let pending: (() => Promise<void>) | null = step;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (pending && commands.some((c) => c.some((part) => part === claimKey(statsId)))) {
      const run = pending;
      pending = null;
      await run();
    }
    return real(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = real;
  };
}

const run = () => sendPaydayEmails(Date.now() + 20_000, NOW);

async function main(): Promise<void> {
  part("A live store still gets its payday email and keeps the month");
  const live = await seed("payday-live@example.com", "paydaylive");
  is("one email", [(await run()).sent, sent], [1, 1]);
  is("the month's claim is kept", claimExists(live.statsId), true);

  part("A store with an id whose erasure begins right before the claim: no claim, no email");
  const erased = await seed("payday-erased@example.com", "paydayerased");
  const undo1 = beforeClaim(erased.statsId, () => beginErasure(erased, true));
  const out1 = await run();
  undo1();
  is("nothing sent", [out1.sent, sent], [0, 0]);
  is("no claim written for the erased store", claimExists(erased.statsId), false);

  part("Erasing mark only, the record still there: the same");
  const marked = await seed("payday-marked@example.com", "paydaymarked");
  const undo2 = beforeClaim(marked.statsId, () => beginErasure(marked, false));
  const out2 = await run();
  undo2();
  is("nothing sent", [out2.sent, sent], [0, 0]);
  is("no claim written", claimExists(marked.statsId), false);

  part("An erasure that ends while the email is sent: the keep never writes the month back");
  const late = await seed("payday-late@example.com", "paydaylate");
  duringEmail = async () => {
    await beginErasure(late);
    // The closing walk deletes the store's family, the month's claim among them.
    await redis.pipeline([["DEL", claimKey(late.statsId)]]);
  };
  await run();
  is("the email that was already on its way went", sent, 1);
  is("the erased store's month is not written back", claimExists(late.statsId), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
