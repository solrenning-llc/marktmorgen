/**
 * What a store's month was already billed, read exactly before anything is
 * added to an invoice (lib/usage-billing.ts settleUsage, CX-123 rule 24).
 *
 * Two keys say it: the billed figure (nil is nothing billed yet, a whole
 * number of cents is what was) and the line being added (nil is none; a
 * record of the line otherwise). Any other answer, or a record that cannot
 * be read, is unknown: the store's month is not settled on it, nothing is
 * added to an invoice, and it is tried again on the next run. Read loosely,
 * an unknown billed figure was 0 and an unknown line was none, so the month
 * was charged again from 0.
 *
 * No meter owes anything today (232 [CA1] unit 3); a meter made here owes a
 * fixed figure, so the path that would charge is the one tested. Synthetic
 * data only, Stripe answered here.
 */
import { settleUsage, type Meter } from "@/lib/usage-billing";
import { rememberFolderOwner } from "@/lib/delivery";
import { claimHandle, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_usage_billing_exact_only";

/** What reached Stripe that adds to an invoice. */
const charges: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.stripe.com" && method === "POST" && url.pathname.includes("invoiceitems")) {
    charges.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: `ii_${charges.length}`, object: "invoiceitem" }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
let inject: ((commands: Command[]) => unknown[] | null) | null = null;
let seen: Command[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  seen.push(...commands);
  const instead = inject?.(commands);
  if (instead) return instead;
  return pipeline(commands);
}) as typeof redis.pipeline;

const OWED = 500;
const meter: Meter = {
  name: "testmeter",
  measured: async () => 10,
  owed: () => OWED,
  byPlan: false,
  covered: 0,
  describe: (month) => `Test use in ${month}`,
  folders: async () => [],
};

async function main(): Promise<void> {
  redis.clear();
  const email = "meter@example.com";
  await claimHandle(email, "meter", "Meter Shop", "");
  await setSubscription(email, { customerId: "cus_Meter000001", subscriptionId: "sub_Meter000001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  await rememberFolderOwner(folder, email);
  const month = new Date().toISOString().slice(0, 7);
  const billed = `nl:testmeter:billed:${folder}:${month}`;
  const adding = `nl:testmeter:adding:${folder}:${month}`;
  const reads = (c: Command[]) => c.length === 2 && c[0][0] === "GET" && c[0][1] === billed && c[1][0] === "GET" && c[1][1] === adding;

  /** Settles the month once: what it answered, what reached Stripe, and whether a new line was written down to add. */
  const settle = async () => {
    const before = charges.length;
    seen = [];
    const state = await settleUsage(meter, folder, month, true).then((row) => row.state, () => "unknown");
    return { state, charged: charges.length - before, lineBegun: seen.some((c) => c[0] === "SET" && c[1] === adding) };
  };

  part("Healthy: billed once, then nothing more");
  is("nothing billed yet (nil, nil): the month is billed", await settle(), { state: "billed", charged: 1, lineBegun: true });
  is("the figure is written", await pipeline([["GET", billed]]), [String(OWED)]);
  is("billed already: nothing more", await settle(), { state: "nothing", charged: 0, lineBegun: false });

  part("The billed figure in another shape: unknown, never 0");
  for (const [label, reply] of [
    ["no reply at all", []],
    ["one reply for two", [String(OWED)]],
    ["undefined", [undefined, null]],
    ["a negative number", [-1, null]],
    ["not a number", ["lots", null]],
    ["a negative figure", ["-5", null]],
    ["a fraction", ["1.5", null]],
    ["an empty string", ["", null]],
  ] as [string, unknown[]][]) {
    inject = (c) => (reads(c) ? reply : null);
    is(`billed answered ${label}: not settled, nothing charged`, await settle(), { state: "unknown", charged: 0, lineBegun: false });
    inject = null;
  }

  part("The line being added in another shape: unknown, never \"none\"");
  for (const [label, reply] of [
    ["undefined", ["0", undefined]],
    ["a number", ["0", 1]],
    ["not JSON", ["0", "{"]],
    ["a record without its customer", ["0", JSON.stringify({ from: 0, to: OWED, at: 1, amount: 10, line: "x", subscriptionId: "sub_Meter000001" })]],
    ["a record whose figures go backwards", ["0", JSON.stringify({ from: OWED, to: 0, at: 1, amount: 10, line: "x", customerId: "cus_Meter000001", subscriptionId: "sub_Meter000001" })]],
    ["a JSON list", ["0", "[]"]],
    // Claude 5 on #2944 (MEDIUM 1): figures that are not whole cents were read as a line carried out or past what is
    // owed, deleted, and the month begun again from what was billed.
    ["a record from a fraction of a cent", ["0", JSON.stringify({ from: 0.5, to: OWED, at: 1, amount: 10, line: "x", customerId: "cus_Meter000001", subscriptionId: "sub_Meter000001" })]],
    ["a record to a figure past any number", ["0", `{"from":0,"to":1e400,"at":1,"amount":10,"line":"x","customerId":"cus_Meter000001","subscriptionId":"sub_Meter000001"}`]],
    ["a record begun at a fraction of a time", ["0", JSON.stringify({ from: 0, to: OWED, at: 1.5, amount: 10, line: "x", customerId: "cus_Meter000001", subscriptionId: "sub_Meter000001" })]],
  ] as [string, unknown[]][]) {
    inject = (c) => (reads(c) ? reply : null);
    is(`line answered ${label}: not settled, nothing charged`, await settle(), { state: "unknown", charged: 0, lineBegun: false });
    inject = null;
  }

  // Claude 5 on #2944 (MEDIUM 2): the line written down before Stripe is asked is the only thing that stops a second
  // charge; a write whose answer is not an exact "OK" is not known to be there, so nothing is charged on it.
  part("The line written down before the charge: charged only on an exact OK");
  const writesLine = (c: Command[]) => c.length === 1 && c[0][0] === "SET" && c[0][1] === adding;
  for (const [label, reply] of [["no reply", []], ["null", [null]], ["another word", ["QUEUED"]], ["two replies", ["OK", "OK"]]] as [string, unknown[]][]) {
    await pipeline([["DEL", billed], ["DEL", adding]]);
    inject = (c) => (writesLine(c) ? reply : null);
    is(`the line's write answered ${label} (not written): nothing charged`, await settle(), { state: "unknown", charged: 0, lineBegun: true });
    inject = null;
  }
  await pipeline([["DEL", billed], ["DEL", adding]]);
  // The write is applied, then its answer is lost (the wrapper above hands this promise's [] back as the reply).
  inject = (c) => (writesLine(c) ? (pipeline(c).then(() => []) as unknown as unknown[]) : null);
  is("the line's write landed with its answer lost: nothing charged this run", await settle(), { state: "unknown", charged: 0, lineBegun: true });
  inject = null;
  is("the next run finishes that line once, never begins another", await settle(), { state: "billed", charged: 1, lineBegun: false });
  is("billed once in all", await settle(), { state: "nothing", charged: 0, lineBegun: false });

  part("Confirmed: a line written down and not finished is finished, not begun again");
  await pipeline([["DEL", billed]]);
  await pipeline([["SET", adding, JSON.stringify({ from: 0, to: OWED, at: Date.now(), amount: 10, line: "Test use", customerId: "cus_Meter000001", subscriptionId: "sub_Meter000001" })]]);
  is("the unfinished line is carried out once", await settle(), { state: "billed", charged: 1, lineBegun: false });
  is("and the figure written", await pipeline([["GET", billed]]), [String(OWED)]);

  done();
}

void main();
