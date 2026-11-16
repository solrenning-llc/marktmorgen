/**
 * Rule 24 for the deletion link asked for every store (lib/erasure-request.ts,
 * askErasureLink): a store that knows the address but whose record does not
 * read is unknown, never "not there".
 *
 * On main each store was read with storeForId(...).catch(() => null), and a
 * store that did not read was left out of the link: the person was emailed a
 * link naming only the other stores, pressed it, was told "done", and the
 * store that did not read kept everything about them. readErasureLink already
 * refuses to show part of a link's scope for the same reason. Now a store
 * whose record does not read stops the link (logged; the page gives the
 * privacy contact, and asking again sends the whole link once it reads); a
 * store that is really gone (no record) is still left out. Synthetic data only.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { rememberBuyers } from "@/lib/buyer-library";
import { askErasureLink } from "@/lib/erasure-request";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const mails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    mails.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

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

const settled = () => new Promise((resolve) => setTimeout(resolve, 300));

/** The deletion grants written while `run` runs (SET nl:erase:link:*), as their store ids. */
async function grantsWhile(storeRecordReply: (sid: string) => unknown | undefined, run: () => Promise<unknown>): Promise<string[][]> {
  const grants: string[][] = [];
  const original = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) => {
    const [name, key, value] = commands[0] ?? [];
    if (commands.length === 1 && name === "GET" && typeof key === "string" && key.startsWith("nl:store:id:")) {
      const reply = storeRecordReply(key.slice("nl:store:id:".length));
      if (reply !== undefined) return reply as Awaited<ReturnType<typeof original>>;
    }
    if (name === "SET" && typeof key === "string" && key.startsWith("nl:erase:link:")) grants.push((JSON.parse(String(value)) as { s: string[] }).s);
    return original.call(redis, commands);
  };
  try {
    await run();
    await settled();
  } finally {
    redis.pipeline = original;
  }
  return grants;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_timing_only_a_stand_in";
  const one = await paidStore("erase-scope-one");
  const two = await paidStore("erase-scope-two");
  let n = 0;
  const ask = async (email: string) => askErasureLink({ email, ip: `198.51.100.${++n}`, origin: "https://marktmorgen.com" });

  part("Both stores read: one link for both");
  const both = "both-at-scope@example.com";
  await rememberBuyers(one.sid, [both]);
  await rememberBuyers(two.sid, [both]);
  const whole = await grantsWhile(() => undefined, () => ask(both));
  is("one grant naming both stores", whole.map((g) => [...g].sort()), [[one.sid, two.sid].sort()]);

  for (const [label, reply] of [["a number", [7]], ["an object", [{}]], ["no reply", []], ["two replies", [null, null]]] as const) {
    part(`One store's record answers ${label}: no link naming only the other`);
    const before = mails.length;
    const email = `unread-${n}-at-scope@example.com`;
    await rememberBuyers(one.sid, [email]);
    await rememberBuyers(two.sid, [email]);
    const grants = await grantsWhile((sid) => (sid === two.sid ? reply : undefined), () => ask(email));
    is("no grant leaves out the store that did not read", grants.filter((g) => !g.includes(two.sid)), []);
    is("and no link is emailed for part of the scope", mails.length - before, 0);
  }

  part("A store really gone (no record) is left out, as before");
  const gone = "gone-at-scope@example.com";
  await rememberBuyers(one.sid, [gone]);
  await rememberBuyers(two.sid, [gone]);
  const before = mails.length;
  const grants = await grantsWhile((sid) => (sid === two.sid ? [null] : undefined), () => ask(gone));
  is("one grant naming the store that is there", grants, [[one.sid]]);
  is("and its link is emailed", mails.length - before, 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
