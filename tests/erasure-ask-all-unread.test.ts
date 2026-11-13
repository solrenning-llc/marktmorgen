/**
 * The public deletion form asked for every store (/privacy/delete, scope=all;
 * lib/erasure-request.ts, askErasureLink) reads each store that knows the
 * address by its id. A read that failed or answered in an unknown shape was
 * taken for "no such store" (storeForId(sid).catch(() => null)): that store
 * left the link without a word, so the person deleted from fewer stores than
 * they asked and nothing told them (rule 24; Claude 5 on #2970, LIGHT).
 *
 * Now the store is read exactly (storeForIdExact). Only a store confirmed not
 * there is left out in silence. An unread one is counted, and the email the
 * person gets says how many more stores could not be checked and to ask again;
 * when none could be read, nothing is sent and the server's log says why. The
 * answer on the page stays "sent" for every address (review C4-7), healthy and
 * unread alike, so it still tells nobody who buys where.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { rememberBuyers, storesKnownFor } from "@/lib/buyer-library";
import { readErasureLink } from "@/lib/erasure-request";
import { POST as eraseRoute } from "@/app/api/privacy/erase/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];

const sent: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to?: unknown; text?: string };
    sent.push({ to: String(body.to), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

const logged: string[] = [];
for (const level of ["warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    if (process.env.FULL) original(...args);
  };
}

async function paidStore(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1${handle.replace(/[^a-z]/g, "").padEnd(14, "x").slice(0, 14)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/[^a-z0-9]/g, "")}`, subscriptionId: `sub_${handle.replace(/[^a-z0-9]/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

let ip = 0;
async function askAll(email: string): Promise<{ status: number; body: string; location: string }> {
  ip += 1;
  const response = await eraseRoute(
    new NextRequest("https://marktmorgen.com/api/privacy/erase", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${ip}` },
      body: new URLSearchParams({ action: "ask", email, scope: "all" }),
    }),
  );
  const answer = { status: response.status, body: await response.text(), location: response.headers.get("location") ?? "" };
  // What depends on the address runs after the answer: let it finish.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  return answer;
}

const real = redis.pipeline.bind(redis);
const isIdRead = (batch: Command[], sid: string) => batch.length === 1 && batch[0][0] === "GET" && batch[0][1] === `nl:store:id:${sid}`;
const isOwnerRead = (batch: Command[]) => batch.length === 1 && batch[0][0] === "GET" && String(batch[0][1]).startsWith("nl:store:owner:");

type Fault = { name: string; on: "id" | "owner"; reply: unknown[] | "throw" };

/** Answers one store's id read (or the owner record read right after it) as `fault` says; every other read is real. */
function faulty(sids: string[], fault: Fault): void {
  let armed = false;
  redis.pipeline = (async (batch: Command[]) => {
    const id = sids.some((sid) => isIdRead(batch, sid));
    if (fault.on === "id" && id) {
      if (fault.reply === "throw") throw new Error("connection reset");
      return [...fault.reply];
    }
    if (fault.on === "owner" && id) {
      armed = true;
      return real(batch);
    }
    if (fault.on === "owner" && armed && isOwnerRead(batch)) {
      armed = false;
      if (fault.reply === "throw") throw new Error("connection reset");
      return [...fault.reply];
    }
    return real(batch);
  }) as typeof redis.pipeline;
}

const tokenIn = (text: string) => /token=([0-9a-f]{64})/.exec(text)?.[1] ?? "";
const UNREAD = /could not check/i;

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_scope_all_only_a_stand_in";
  const first = await paidStore("unread-all-first");
  const second = await paidStore("unread-all-second");
  const STRANGER = "nobody-anywhere@example.com";
  // A new address known to both stores for each ask, so the hourly limit per address never decides one.
  let n = 0;
  const known = async () => {
    n += 1;
    const email = `at-both-${n}@example.com`;
    await rememberBuyers(first.sid, [email]);
    await rememberBuyers(second.sid, [email]);
    return email;
  };
  let KNOWN = await known();
  is("the address is known to both stores", (await storesKnownFor(KNOWN)).sort(), [first.sid, second.sid].sort());

  part("Control: both stores read, one link for both, no word about unread stores");
  let from = sent.length;
  const healthy = await askAll(KNOWN);
  const stranger = await askAll(STRANGER);
  let mails = sent.slice(from);
  is("one email, to the address", mails.map((m) => m.to), [KNOWN]);
  is("its link deletes from both stores", ((await readErasureLink(tokenIn(mails[0]?.text ?? "")))?.stores ?? []).map((s) => s.sid).sort(), [first.sid, second.sid].sort());
  is("it says nothing about a store not checked", UNREAD.test(mails[0]?.text ?? ""), false);
  is("the answer is the same as for an address nobody knows", healthy, stranger);

  const faults: Fault[] = [
    { name: "the id read throws", on: "id", reply: "throw" },
    { name: "the id read has no reply", on: "id", reply: [] },
    { name: "the id read answers 42", on: "id", reply: [42] },
    { name: "the id read answers a list", on: "id", reply: [["owner@example.com"]] },
    { name: "the owner record answers 7", on: "owner", reply: [7] },
    { name: "the owner record is not a store", on: "owner", reply: ["{}"] },
  ];
  for (const fault of faults) {
    part(`One store unread (${fault.name}): the link for the other, and the email says one store was not checked`);
    from = sent.length;
    KNOWN = await known();
    faulty([second.sid], fault);
    const answer = await askAll(KNOWN);
    redis.pipeline = real as typeof redis.pipeline;
    mails = sent.slice(from);
    is(`${fault.name}: one email, to the address`, mails.map((m) => m.to), [KNOWN]);
    is(`${fault.name}: its link deletes from the store that was read`, ((await readErasureLink(tokenIn(mails[0]?.text ?? "")))?.stores ?? []).map((s) => s.sid), [first.sid]);
    is(`${fault.name}: the email says one more store could not be checked, and to ask again`, [UNREAD.test(mails[0]?.text ?? ""), /\b1 more store\b/.test(mails[0]?.text ?? ""), /ask again/i.test(mails[0]?.text ?? "")], [true, true, true]);
    is(`${fault.name}: the answer is still the same as for an address nobody knows`, answer, stranger);
  }

  part("No store can be read: nothing is sent, and the server's log says how many were not read");
  from = sent.length;
  const logFrom = logged.length;
  KNOWN = await known();
  faulty([first.sid, second.sid], { name: "both answer 42", on: "id", reply: [42] });
  const none = await askAll(KNOWN);
  redis.pipeline = real as typeof redis.pipeline;
  is("nothing is sent", sent.length, from);
  is("the log says 2 stores could not be read", logged.slice(logFrom).some((line) => /2 stores? .*could not be read/i.test(line)), true);
  is("the answer is still the same as for an address nobody knows", none, stranger);

  part("Control: a store confirmed not there leaves the link in silence, as before");
  from = sent.length;
  KNOWN = await known();
  redis.pipeline = (async (batch: Command[]) => (isIdRead(batch, second.sid) ? [null] : real(batch))) as typeof redis.pipeline;
  const gone = await askAll(KNOWN);
  redis.pipeline = real as typeof redis.pipeline;
  mails = sent.slice(from);
  is("one email, to the address", mails.map((m) => m.to), [KNOWN]);
  is("its link deletes from the store that is there", ((await readErasureLink(tokenIn(mails[0]?.text ?? "")))?.stores ?? []).map((s) => s.sid), [first.sid]);
  is("it says nothing about a store not checked", UNREAD.test(mails[0]?.text ?? ""), false);
  is("the answer is the same", gone, stranger);

  part("Control: read again once the store answers, both are back on the link");
  from = sent.length;
  KNOWN = await known();
  await askAll(KNOWN);
  mails = sent.slice(from);
  is("its link deletes from both stores again", ((await readErasureLink(tokenIn(mails[0]?.text ?? "")))?.stores ?? []).map((s) => s.sid).sort(), [first.sid, second.sid].sort());

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
