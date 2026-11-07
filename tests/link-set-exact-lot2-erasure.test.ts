/**
 * The public deletion form (/privacy/delete, lib/erasure-request.ts) emails a
 * link that deletes a person's data only once Redis said it stored that link
 * (rule 24, the signin-link-set-exact pattern, lot 2):
 *
 *   - a SET of the link that got no answer, or an answer other than exactly
 *     "OK", sends no paid email, and the link, in case it landed with its
 *     answer lost, is deleted, so no live deletion link is left that nobody got;
 *   - asked from one store and asked for every store, the public answer stays
 *     "sent" whatever happened, for an address a store knows and one none
 *     does, so the form still tells nobody who buys where;
 *   - with Redis answering "OK", the link is emailed and opens the page.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { rememberBuyers } from "@/lib/buyer-library";
import { askErasureLink, readErasureLink } from "@/lib/erasure-request";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { afterTasks } from "./next-server-after-world";

/** Runs what the answers left for after them, as Next does once each answer is sent. */
async function runAfterTasks(): Promise<void> {
  while (afterTasks.length) await (afterTasks.shift() as () => unknown)();
}

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

const sent: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to?: unknown; text?: string };
    sent.push({ to: String([body.to].flat()[0]), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

/** Runs `work` with the one-command SET of a key starting with `prefix` answered by `reply`; with `apply` the SET is still made. */
async function setAnswered<T>(prefix: string, reply: unknown[], work: () => Promise<T>, apply: boolean): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith(prefix)) {
      if (apply) await original.call(redis, commands);
      return reply;
    }
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** Short, empty, other-shaped and lost answers to a SET: none of them is "stored". */
const ODD: [string, unknown[]][] = [
  ["no reply at all", []],
  ["a null reply", [null]],
  ["an undefined reply", [undefined]],
  ["a reply of another word", ["QUEUED"]],
  ["two replies for one command", ["OK", "OK"]],
];

const LINK = "nl:erase:link:";
const links = () => redis.keys().filter((key) => key.startsWith(LINK)).length;
const tokenIn = (text: string) => /token=([0-9a-f]{64})/.exec(text)?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_asked_only_a_stand_in";
  const owner = "owner@erase-set.example";
  await claimHandle(owner, "erase-set", "Erase Set", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1EraseSetXXXXXX", true);
  await setSubscription(owner, { customerId: "cus_eraseset", subscriptionId: "sub_eraseset", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  // On the store's list (found when asked from that store) and noted as a buyer (found when asked for every store).
  const known = async (email: string) => {
    await upsertContact(store.listId as string, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);
    await rememberBuyers(store.sid as string, [email]);
  };
  let ip = 0;
  const ask = async (email: string, handle?: string) =>
    (await askErasureLink({ email, ip: `203.0.113.${(ip += 1)}`, origin: "https://marktmorgen.com", ...(handle ? { handle } : {}) })).status;

  part("Control: Redis answers OK, the link is emailed and opens the page");
  await known("control@example.com");
  const control = await ask("control@example.com", "erase-set");
  await runAfterTasks();
  const controlToken = tokenIn(sent.find((s) => s.to === "control@example.com")?.text ?? "");
  is("the answer is sent, and the link went", [control, controlToken.length], ["sent", 64]);
  is("the emailed link opens for that address", (await readErasureLink(controlToken))?.email, "control@example.com");

  for (const [handle, where] of [["erase-set", "asked from one store"], ["", "asked for every store"]] as const) {
    part(`A link whose SET was not confirmed, ${where}: no email, no link left, the same answer`);
    for (const [what, reply] of ODD) {
      for (const apply of [false, true]) {
        const email = `odd${ip + 1}@example.com`;
        await known(email);
        const before = sent.length;
        const linksBefore = links();
        const answer = await setAnswered(LINK, reply, async () => {
          const status = await ask(email, handle || undefined);
          await runAfterTasks();
          return status;
        }, apply);
        const label = `${what}${apply ? " (the SET landed)" : ""}`;
        is(`${label}: the public answer is still "sent"`, answer, "sent");
        is(`${label}: no deletion email`, sent.slice(before).filter((s) => s.to === email).length, 0);
        is(`${label}: no deletion link left behind`, links(), linksBefore);
      }
    }
    is(`${where}: an address no store knows gets the same answer`, await ask(`nobody${ip + 1}@example.com`, handle || undefined), "sent");
    await runAfterTasks();
  }

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
