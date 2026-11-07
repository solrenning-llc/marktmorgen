/**
 * What was taken with a certain reply is given back when a later take's reply
 * is unknown (independent review 1 of the SG2 L8 batch, finding 2).
 *
 * takeCredit (lib/closing-credit.ts) and takeCalls (lib/closing-holds.ts)
 * throw UnknownReplyError when DECRBY's or HINCRBY's total is not a whole
 * number: it is not known whether that take ran, so it is never given back.
 * But the takes before it in the same loop answered exactly, and their emails
 * or Stripe calls are never made once the loop stops. Before this fix they
 * were lost too:
 *
 *   - tellBuyers (lib/closing-buyers.ts): the credit of every address already
 *     in the batch (up to 99), so later rounds ran out of the closing's credit
 *     early and those buyers were counted as untold;
 *   - tellRefundShort: the same, one email each;
 *   - giveBackUnused (lib/closing-refunds.ts): on the closing day the three
 *     calls taken from the reserve (rcalls) for a member's refund, when the
 *     next take, from the budget, answered unknown; the refund could then
 *     fall into "unmade".
 *
 * Now each gives back exactly what was taken with certainty before the
 * unknown reply and throws again. The stand-in Redis below runs the unknown
 * take for real and only garbles its reply, so afterwards each counter is the
 * starting value minus only that one take's amount.
 */
import { creditKey, startClosingCredit } from "@/lib/closing-credit";
import { EMAILS_PER_BUYER_PER_ENDING } from "@/lib/closing-buyers-rules";
import { tellBuyers, tellRefundShort } from "@/lib/closing-buyers";
import { paidKey, workKey } from "@/lib/closing-holds";
import { giveBackUnused } from "@/lib/closing-refunds";
import { claimHandle, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The take (by command name and key prefix) whose reply is garbled, and on which of them (1 = the first). */
let garble: { name: string; prefix: string; field?: string; on: number; seen: number } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = await pipeline(commands);
  const c = commands[0];
  if (garble && commands.length === 1 && c?.[0] === garble.name && String(c[1]).startsWith(garble.prefix) && (garble.field === undefined || c[2] === garble.field)) {
    garble.seen += 1;
    // The take ran; only its reply is out of shape (a total written as text).
    if (garble.seen === garble.on) return [String(replies[0])];
  }
  return replies;
}) as typeof redis.pipeline;

async function outcome<T>(run: () => Promise<T>): Promise<T | "rejected"> {
  try {
    return await run();
  } catch {
    return "rejected";
  }
}

const creditOf = async (folder: string) => Number((await redis.pipeline([["GET", creditKey(folder)]]))[0]);
const budgetOf = async (folder: string) => ((await redis.pipeline([["HMGET", workKey(folder), "calls", "rcalls"]]))[0] as unknown[]).map(Number);

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.pathname.endsWith("/balance")) return json({ available: [{ amount: 1_000_000, currency: "usd" }] });
  return json({ error: { message: "not stubbed" } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const realError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  const owner = "sg2-l8-giveback@example.com";
  await claimHandle(owner, "sglightgive", "SG L8 Give", "");
  const shop = await storeForEmail(owner);
  if (!shop) throw new Error("the test store was not made");
  const folder = await storeFolder(storeRef(shop));
  const E = Date.UTC(2026, 10, 1);

  // ----------------------------------------------------------- tellBuyers
  part("tellBuyers: the credit of the addresses already taken comes back when a later take is unknown");
  {
    await redis.pipeline([["HSET", workKey(folder), "m:sub_sgl8a1", "one@example.com", "m:sub_sgl8a2", "two@example.com", "m:sub_sgl8a3", "three@example.com", "m:sub_sgl8a4", "four@example.com"]]);
    const START = 100;
    await startClosingCredit(folder, START);
    garble = { name: "DECRBY", prefix: "nl:closing:credit:", on: 3, seen: 0 };
    const told = await outcome(() => tellBuyers(shop, E, E + 30 * 86_400_000, "", Date.now() + 60_000));
    garble = null;
    is("the round stops (unknown is never \"sent\")", told, "rejected");
    is("the credit is the start less only the unknown take", await creditOf(folder), START - EMAILS_PER_BUYER_PER_ENDING);
    is("nobody is marked told", ((await redis.pipeline([["HGETALL", `nl:closing:told:${folder}`]]))[0] as unknown[]).length, 0);
  }

  // ------------------------------------------------------ tellRefundShort
  part("tellRefundShort: the emails already taken come back when a later take is unknown");
  {
    const START = 50;
    await startClosingCredit(folder, START);
    const short = ["a", "b", "c", "d"].map((n) => ({ email: `short-${n}@example.com`, amount: 500, cur: "usd" }));
    garble = { name: "DECRBY", prefix: "nl:closing:credit:", on: 3, seen: 0 };
    const told = await outcome(() => tellRefundShort(shop, short, E));
    garble = null;
    is("the round stops", told, "rejected");
    is("the credit is the start less only the unknown take (one email)", await creditOf(folder), START - 1);
  }

  // ------------------------------------------------------ giveBackUnused
  part("giveBackUnused: on the closing day, the reserve's calls come back when the budget's take is unknown");
  {
    const store: Store = { ...(shop as Store), stripeAccountId: "acct_sgl8give" };
    const now = Math.floor(Date.now() / 1000);
    // No payment named (need 5): three from the reserve, then two from the budget.
    await redis.pipeline([["HSET", paidKey(folder), "sub_sgl8refund", JSON.stringify({ inv: "in_sgl8refund", amt: 1000, cur: "usd", ps: now - 15 * 86_400, pe: now + 15 * 86_400, e: "member@example.com" })]]);
    await redis.pipeline([["HSET", workKey(folder), "calls", 40, "rcalls", 10]]);
    garble = { name: "HINCRBY", prefix: "nl:closing:work:", field: "calls", on: 1, seen: 0 };
    const settled = await outcome(() => giveBackUnused(store, Date.now(), { final: true }));
    garble = null;
    is("the run stops", settled, "rejected");
    is("the reserve is whole again; the budget is less only the unknown take", await budgetOf(folder), [40 - 2, 10]);
    is("the lock is let go", (await redis.pipeline([["GET", `nl:closing:refund:${folder}`]]))[0], null);
  }

  // ------------------------------------------- a give-back whose reply is unknown
  part("a give-back whose own reply is unknown is logged, never tried again in a loop");
  {
    const START = 100;
    await startClosingCredit(folder, START);
    await redis.pipeline([["DEL", `nl:closing:told:${folder}`]]);
    garble = { name: "DECRBY", prefix: "nl:closing:credit:", on: 3, seen: 0 };
    let increments = 0;
    const inner = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await inner(commands);
      if (commands.length === 1 && commands[0][0] === "INCRBY" && String(commands[0][1]).startsWith("nl:closing:credit:")) {
        increments += 1;
        return ["garbled"];
      }
      return replies;
    }) as typeof redis.pipeline;
    logged.length = 0;
    const told = await outcome(() => tellBuyers(shop, E, E + 30 * 86_400_000, "", Date.now() + 60_000));
    redis.pipeline = inner;
    garble = null;
    is("the round stops", told, "rejected");
    is("one give-back, never repeated", increments, 1);
    is("its unknown reply is logged", logged.some((line) => line.includes("credit") && line.includes("unknown")), true);
  }

  part("giveBackUnused: a give-back of calls whose own reply is unknown is logged, never tried again in a loop");
  {
    const store: Store = { ...(shop as Store), stripeAccountId: "acct_sgl8give" };
    await redis.pipeline([["HSET", workKey(folder), "calls", 40, "rcalls", 10]]);
    garble = { name: "HINCRBY", prefix: "nl:closing:work:", field: "calls", on: 1, seen: 0 };
    let givenBack = 0;
    const inner = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await inner(commands);
      if (commands.length === 1 && commands[0][0] === "HINCRBY" && commands[0][2] === "rcalls" && Number(commands[0][3]) > 0) {
        givenBack += 1;
        return ["garbled"];
      }
      return replies;
    }) as typeof redis.pipeline;
    logged.length = 0;
    const settled = await outcome(() => giveBackUnused(store, Date.now(), { final: true }));
    redis.pipeline = inner;
    garble = null;
    is("the run stops", settled, "rejected");
    is("one give-back, never repeated", givenBack, 1);
    is("its unknown reply is logged", logged.some((line) => line.includes("calls") && line.includes("unknown")), true);
  }

  console.error = realError;
  done();
}

void main();
