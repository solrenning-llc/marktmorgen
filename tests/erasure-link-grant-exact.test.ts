/**
 * Rule 24 for the deletion link's grant (lib/erasure-request.ts, emailLink;
 * Codex L, 19 November 2026, MEDIUM, erasure): the link's scope is written as
 * nl:erase:link:<hash>, and the email with its token goes out only once Redis
 * answered that write exactly "OK".
 *
 * On main the SET's reply was not read: a write Redis refused, or answered in
 * any other shape, still emailed the token, the person opened a link with no
 * grant behind it, and the stores kept everything about them. Now a reply that
 * is not exactly one "OK" sends nothing: the possible grant is deleted (a reply
 * that is not known may hide a write that landed) and the request answers
 * "error", which names no address. Synthetic data only.
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
/** Every grant key a SET was asked for during the test. */
const asked = new Set<string>();
/** The grant keys that still exist in Redis. */
const linkKeys = async () => {
  const left: string[] = [];
  for (const key of asked) if ((await redis.pipeline([["EXISTS", key]]))[0] === 1) left.push(key);
  return left;
};

/**
 * Runs `run` with the grant's SET answered by `reply`. `lands` says whether the write reaches Redis first (a reply
 * lost after the write) or not at all (a refused write).
 */
async function withGrantReply(reply: unknown, lands: boolean, run: () => Promise<unknown>): Promise<void> {
  const original = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) => {
    const [name, key] = commands[0] ?? [];
    if (commands.length === 1 && name === "SET" && typeof key === "string" && key.startsWith("nl:erase:link:")) {
      asked.add(key);
      if (lands) await original.call(redis, commands);
      return reply as Awaited<ReturnType<typeof original>>;
    }
    return original.call(redis, commands);
  };
  try {
    await run();
    await settled();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_timing_only_a_stand_in";
  const shop = await paidStore("erase-grant-exact");
  let n = 0;
  const ask = async (email: string) => askErasureLink({ email, ip: `198.51.100.${++n}`, origin: "https://marktmorgen.com" });

  part("A grant Redis confirmed: its link is emailed");
  const fine = "fine-at-grant@example.com";
  await rememberBuyers(shop.sid, [fine]);
  let before = mails.length;
  await withGrantReply(["OK"], true, () => ask(fine));
  is("one email with the link", mails.length - before, 1);
  is("and its grant is kept for the link", (await linkKeys()).length, 1);

  const cases = [
    ["refused (null), nothing written", [null], false],
    ["an empty reply, nothing written", [], false],
    ["an error text, nothing written", ["ERR out of memory"], false],
    ["a reply lost after the write landed (null)", [null], true],
    ["two replies after the write landed", ["OK", "OK"], true],
  ] as const;
  for (const [label, reply, lands] of cases) {
    part(`The grant's write answered ${label}`);
    for (const key of await linkKeys()) await redis.pipeline([["DEL", key]]);
    const email = `case-${n}-at-grant@example.com`;
    await rememberBuyers(shop.sid, [email]);
    before = mails.length;
    await withGrantReply(reply, lands, () => ask(email));
    is("no deletion link is emailed without a confirmed grant", mails.length - before, 0);
    is("and no possible grant is left behind", (await linkKeys()).length, 0);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
