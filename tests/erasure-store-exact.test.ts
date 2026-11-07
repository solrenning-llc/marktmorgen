/**
 * A deletion request (/privacy/delete, lib/erasure-request.ts) is never lost
 * in silence because a store could not be read just now (rule 24, review of
 * #2970, regra 30):
 *
 *   (a) asked from one store, a read of that store that fails or comes back in
 *       an unknown shape (no reply, a number) is "error", which says only that
 *       the store could not be read; never "sent" with no link emailed. A store
 *       that truly is not there, or a name that was let go, is still "sent",
 *       as before, and a store that answers is still emailed from.
 *   (b) asked for every store, the answer stays "sent" for everybody (it must
 *       not tell which stores know the address), but a store that could not be
 *       read is never dropped without a word: the emailed link says how many
 *       stores it could not include and to ask again; when none could be read,
 *       the failure is logged, not swallowed.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { askErasureLink } from "@/lib/erasure-request";
import { rememberBuyers } from "@/lib/buyer-library";
import { POST as eraseRoute } from "@/app/api/privacy/erase/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = async (observed: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (observed()) return;
    await pause(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

async function paidStore(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, `${handle} shop`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1${handle.replace(/[^a-z]/g, "").padEnd(14, "x").slice(0, 14)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/[^a-z0-9]/g, "")}`, subscriptionId: `sub_${handle.replace(/[^a-z0-9]/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

/** Runs `work` with every pipeline that names a key starting with `prefix` answered by `reply`, or thrown when it is an Error. */
async function answering<T>(prefix: string, reply: unknown[] | Error, work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (!commands.some((command) => command[0] === "GET" && String(command[1] ?? "").startsWith(prefix))) return original.call(redis, commands);
    if (reply instanceof Error) throw reply;
    return [...reply];
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

let ip = 0;
const ask = async (fields: Record<string, string>): Promise<URL> => {
  ip += 1;
  const answer = await eraseRoute(new NextRequest("https://marktmorgen.com/api/privacy/erase", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${ip}` }, body: new URLSearchParams({ action: "ask", ...fields }) }));
  return new URL(answer.headers.get("location") ?? "https://x.invalid/");
};

let person = 0;
/** A fresh address the given stores know as a buyer, so the per-address limit never decides a case. */
async function buyerOf(...stores: Store[]): Promise<string> {
  person += 1;
  const email = `person${person}@example.com`;
  for (const s of stores) await rememberBuyers(s.sid, [email]);
  return email;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const harbor = await paidStore("harbor-exact");
  const willow = await paidStore("willow-exact");

  part("(a) Asked from one store: healthy control");
  {
    const email = await buyerOf(harbor);
    const from = sent.length;
    const where = await ask({ email, scope: "store", store: harbor.handle });
    is("the answer is sent", where.searchParams.get("status"), "sent");
    await settled(() => sent.slice(from).some((m) => m.to === email), "the healthy deletion email");
    const link = sent.slice(from).find((m) => m.to === email);
    is("a link is emailed, naming that store", [link?.text.includes("/privacy/delete?token="), link?.text.includes(harbor.name)], [true, true]);
  }

  part("(a) Asked from one store that could not be read: error, never 'sent' with no link (MEDIUM)");
  for (const [name, prefix, reply] of [
    ["the handle read throws", "nl:store:handle:", new Error("connection reset")],
    ["the handle answered 42", "nl:store:handle:", [42]],
    ["the handle answered nothing", "nl:store:handle:", []],
    ["the store's record answered 42", "nl:store:owner:", [42]],
    ["the store's record answered nothing", "nl:store:owner:", []],
    ["the store's record read throws", "nl:store:owner:", new Error("connection reset")],
  ] as const) {
    const email = await buyerOf(harbor);
    const from = sent.length;
    const where = await answering(prefix, reply instanceof Error ? reply : [...reply], () => ask({ email, scope: "store", store: harbor.handle }));
    await pause(60);
    is(`${name}: [status, store kept on the page, emails to the address]`, [where.searchParams.get("status"), where.searchParams.get("store"), sent.slice(from).filter((m) => m.to === email).length], ["error", harbor.handle, 0]);
  }
  {
    const email = await buyerOf(harbor);
    const direct = await answering("nl:store:handle:", [42], () => askErasureLink({ email, ip: "203.0.113.99", origin: "https://marktmorgen.com", handle: harbor.handle }).then((a) => a.status, (error: unknown) => `threw ${error instanceof Error ? error.name : "?"}`));
    is("askErasureLink itself never answers 'sent' for an unread store", direct === "sent", false);
  }

  part("(a) A store that truly is not there is still 'sent', as before");
  {
    const email = await buyerOf(harbor);
    is("no such store: sent", (await ask({ email, scope: "store", store: "no-such-exact" })).searchParams.get("status"), "sent");
    const other = await buyerOf(harbor);
    is("a name that was let go: sent", (await answering("nl:store:handle:", ["released:1"], () => ask({ email: other, scope: "store", store: harbor.handle }))).searchParams.get("status"), "sent");
  }

  part("(b) Asked for every store: healthy control says nothing about a store left out");
  {
    const email = await buyerOf(harbor, willow);
    const from = sent.length;
    is("the answer is sent", (await ask({ email, scope: "all" })).searchParams.get("status"), "sent");
    await settled(() => sent.slice(from).some((m) => m.to === email), "the every-store email");
    const link = sent.slice(from).find((m) => m.to === email);
    is("both stores named, nothing said to be left out", [link?.text.includes(harbor.name), link?.text.includes(willow.name), /could not be (read|included|checked)/.test(link?.text ?? "")], [true, true, false]);
  }

  part("(b) One store could not be read: still 'sent', and the email says one store is not included (LIGHT)");
  {
    const email = await buyerOf(harbor, willow);
    const stranger = `stranger${person}@example.com`;
    const from = sent.length;
    const failing = new Error("connection reset");
    const [where, whereStranger] = await answering(`nl:store:id:${willow.sid}`, failing, async () => {
      const w = await ask({ email, scope: "all" });
      const s = await ask({ email: stranger, scope: "all" });
      await settled(() => sent.slice(from).some((m) => m.to === email), "the email with one store left out");
      return [w, s];
    });
    is("the page answer is the same 'sent' a stranger gets", [where.searchParams.get("status"), where.search], ["sent", whereStranger.search]);
    const link = sent.slice(from).find((m) => m.to === email);
    is("the link names the store that was read, not the other", [link?.text.includes(harbor.name), link?.text.includes(willow.name)], [true, false]);
    is("and says one store could not be included, and to ask again", [/1 other store could not be checked just now/.test(link?.text ?? ""), /ask again/i.test(link?.text ?? "")], [true, true]);
  }

  part("(b) No store could be read: still 'sent', nothing emailed, the failure is logged");
  {
    const email = await buyerOf(harbor, willow);
    const from = sent.length;
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    try {
      const where = await answering("nl:store:id:", new Error("connection reset"), async () => {
        const w = await ask({ email, scope: "all" });
        await settled(() => logged.some((line) => line.includes("emailing a deletion link failed")), "the logged failure");
        return w;
      });
      is("the answer is sent", where.searchParams.get("status"), "sent");
    } catch (error) {
      is("the failure is logged when no store could be read", String(error), "logged");
    } finally {
      console.error = originalError;
    }
    is("nothing is emailed", sent.slice(from).filter((m) => m.to === email).length, 0);
    is("the log says how many stores could not be read", logged.some((line) => /2 stores? .*could not be read/.test(line)), true);
  }

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
