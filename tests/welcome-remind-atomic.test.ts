/**
 * Review of #2998 (note on head 786a5251, open): scheduleReminder
 * (lib/welcome-offer-send.ts) wrote the mark that a person's reminder was set
 * (SET NX) and queued the reminder (ZADD "nl:wo:due"), which holds their
 * address, in two separate round trips. forgetWelcomePerson, the erasure part,
 * read the mark and deleted it in a pipeline, which Upstash does not run
 * atomically (other clients' commands may land between its commands).
 *
 * Expected, each order of the two run against each other:
 *   1. An erasure landing between the mark and the queue leaves no reminder
 *      naming the person in that store, and no mark.
 *   2. A reminder set between the erasure's read of the mark and its deletion
 *      is never left in the queue without its mark: either it is gone, or its
 *      mark still says which second holds it, so the next erasure takes it out.
 *   3. The queueing failing after the mark was written does not lose a due
 *      reminder: the mark is not left alone, so the next confirmation sets it.
 *
 * Synthetic data only: the in-memory Redis stand-in, stubbed Stripe and email.
 */
import { createHash } from "node:crypto";
import { forgetWelcomePerson, scheduleReminder } from "@/lib/welcome-offer-send";
import { type Claim, readClaimFull, recordLead, requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_welcome_only_a_stand_in";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    sent.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
    return json({ id: "email_1" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "atomic-owner@example.com";
const EMAIL = "atomic-lead@example.com";
const HOUR = 3600;
const DUE = "nl:wo:due";
const h = createHash("sha256").update(`welcome:${EMAIL}`).digest("hex").slice(0, 32);

type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);
/** Called around every pipeline the code under test sends; null runs it as it is. */
let around: ((commands: Command[]) => Promise<unknown[]> | null) | null = null;
redis.pipeline = (async (commands: Command[]) => {
  const hook = around;
  const handled = hook ? hook(commands) : null;
  return handled ?? pipeline(commands);
}) as typeof redis.pipeline;

const touches = (commands: Command[], text: string) => commands.some((command) => command.some((part) => String(part).includes(text)));
const writesMark = (commands: Command[], markKey: string) => commands.some((c) => (c[0] === "SET" && c[1] === markKey) || (c[0] === "EVAL" && c.includes(markKey)));
const queues = (commands: Command[]) => commands.some((c) => (c[0] === "ZADD" && c[1] === DUE) || (c[0] === "EVAL" && c.includes(DUE)));

async function namesPerson(statsId: string): Promise<boolean> {
  const [all] = await pipeline([["ZRANGEBYSCORE", DUE, "-inf", "+inf"]]);
  return (all as string[]).some((m) => m.includes(h) && m.includes(statsId));
}
async function markThere(markKey: string): Promise<boolean> {
  const [held] = await pipeline([["GET", markKey]]);
  return held !== null;
}
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.message : "?"}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "atomic", "Atomic Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestAtomic0001", true);
  await setSubscription(OWNER, { customerId: "cus_Atomic00001", subscriptionId: "sub_Atomic00001", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  if (!free.ok || !paid.ok) throw new Error("no products");
  for (const p of [free, paid]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  await setWelcomeOffer(OWNER, { product: paid.product.id, percent: 25, hours: 48, coupon: "c_welcome25", remind: true, address: "1 Main St, Springfield, IL 62701" });
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, free.product.id))!;
  const result = await requestCopy({ store, product, email: EMAIL, consent: true, ip: "10.0.9.1", origin: "https://marktmorgen.com" });
  if (result !== "sent") throw new Error(`not sent: ${result}`);
  const token = /token=([0-9a-f]{64})/.exec(sent[sent.length - 1])?.[1] ?? "";
  const claim = (await readClaimFull(token)) as Claim;
  await recordLead(store, claim, "Pantry Guide");
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const markKey = `nl:wo:r:${statsId}:${h}`;
  const asked = Math.floor(Date.parse(claim.at) / 1000);
  const reset = async () => {
    around = null;
    await pipeline([["DEL", markKey, `nl:wo:start:${statsId}:${h}`]]);
    const [all] = await pipeline([["ZRANGEBYSCORE", DUE, "-inf", "+inf"]]);
    for (const m of all as string[]) await pipeline([["ZREM", DUE, m]]);
  };

  part("1. The erasure lands between the mark and the queue (the review's note)");
  await reset();
  let erased: unknown = "not run";
  around = (commands) => {
    if (!writesMark(commands, markKey)) return null;
    around = null;
    // The mark's own round trip runs, then the whole erasure, then the rest of scheduleReminder.
    return (async () => {
      const replies = await pipeline(commands);
      erased = await outcome(() => forgetWelcomePerson(statsId, EMAIL));
      return replies;
    })();
  };
  const set1 = await outcome(() => scheduleReminder(store, claim, token, asked + HOUR));
  around = null;
  is("the reminder was set and the erasure ran in between", [set1, typeof erased], [true, "number"]);
  is("no reminder naming the person in that store survives the erasure", await namesPerson(statsId), false);
  is("and no mark is left", await markThere(markKey), false);

  part("2. A reminder set between the erasure's read of the mark and its deletion");
  await reset();
  let set2: unknown = "not run";
  around = (commands) => {
    if (!touches(commands, markKey) || commands.length < 2 || writesMark(commands, markKey)) return null;
    around = null;
    // A pipeline is not atomic on Upstash: its first command, then the whole scheduleReminder, then the rest.
    return (async () => {
      const [first] = await pipeline([commands[0]]);
      set2 = await outcome(() => scheduleReminder(store, claim, token, asked + HOUR));
      const rest = await pipeline(commands.slice(1));
      return [first, ...rest];
    })();
  };
  const erased2 = await outcome(() => forgetWelcomePerson(statsId, EMAIL));
  around = null;
  is("the erasure finished and the reminder was set in between", [typeof erased2, set2], ["number", true]);
  const left = await namesPerson(statsId);
  is("the reminder is gone, or its mark is still there to find it", !left || (await markThere(markKey)), true);
  await outcome(() => forgetWelcomePerson(statsId, EMAIL));
  is("after the next erasure, no reminder naming the person in that store is left", await namesPerson(statsId), false);

  part("3. The queueing fails after the mark: the due reminder is not lost");
  await reset();
  let failedOnce = false;
  around = (commands) => {
    if (failedOnce || !queues(commands)) return null;
    failedOnce = true;
    return Promise.reject(new Error("network failure before Redis got the request"));
  };
  const first = await outcome(() => scheduleReminder(store, claim, token, asked + HOUR));
  around = null;
  is("the first attempt failed", [failedOnce, typeof first === "string" && String(first).startsWith("rejected")], [true, true]);
  is("no mark is left without its reminder", (await markThere(markKey)) && !(await namesPerson(statsId)), false);
  is("the next confirmation sets the reminder", await outcome(() => scheduleReminder(store, claim, token, asked + 2 * HOUR)), true);
  is("and it is queued", await namesPerson(statsId), true);

  part("4. The reminder's reply read in its exact shape");
  for (const [what, reply] of [["text", "1"], ["2", 2], ["a list", [1]], ["no reply", undefined]] as const) {
    await reset();
    around = (commands) => (queues(commands) ? Promise.resolve(reply === undefined ? [] : [reply]) : null);
    is(`the queueing answered ${what}: rejected, never read as set or not`, String(await outcome(() => scheduleReminder(store, claim, token, asked + HOUR))).startsWith("rejected"), true);
    around = null;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
