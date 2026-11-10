/**
 * The emailed link to read an email kept for members (lib/letter-access.ts, sendLetterLink) is sent only once the
 * SET that keeps its grant answered "OK" (CX-123 rule 24). Before, the reply was never read: when the SET did not
 * land, the holder was still emailed a link, taken from the store's transactional allowance, that opens nothing.
 *
 * Here, every other shape of that reply (none, undefined, a hole, "QUEUED", null, a lower-case "ok", a number, an error object)
 * sends no email, takes nothing from the store's transactional allowance and says so in the server's log; the form's
 * answer stays "sent" for everyone, as it is designed to (the answer never tells a holder from anyone else). A
 * pipeline that throws sends nothing either. A healthy SET still emails a link that opens, and asking again after a
 * failed SET does. Synthetic store, Stripe and Resend only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import type { Broadcast } from "@/lib/broadcasts";
import { publishLetter } from "@/lib/letters";
import type { Letter } from "@/lib/letter-rules";
import { readLetterGrant, requestLetterLink } from "@/lib/letter-access";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_letter_link_grant_set";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
const OWNER = "letter-link-grant@example.com";
const HANDLE = "maragrant";
const NOW = Math.floor(Date.now() / 1000);
let club = "";
const mails: { to: string; text: string }[] = [];
let resendCalls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    resendCalls += 1;
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    mails.push({ to: [body.to].flat()[0], text: body.text });
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const who = url.searchParams.get("customer_details[email]") ?? "";
  if (path === "/checkout/sessions" && /^member\d+@example\.com$/.test(who)) {
    const n = who.replace(/\D/g, "").padStart(3, "0");
    return answer({ object: "list", has_more: false, data: [{ id: `cs_test_grant00000${n}`, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", created: NOW - 86_400, customer: `cus_TestGrant${n}`, metadata: { store: HANDLE, product: club }, payment_intent: { id: `pi_grant00000${n}`, latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } } }] });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const logged: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
};

function broadcast(store: Store, id: string): Broadcast {
  const b: Broadcast = { id: id.padStart(24, "0"), listId: store.listId!, handle: store.handle, subject: "October for members", body: "secret", productId: null, notProductId: null, who: "all", narrow: null, status: "sent", createdAt: 1_760_000_000, sendAt: 1_760_000_100, finishedAt: 1_760_000_200, total: 12, sent: 12, note: "", failures: 0, listed: true, tagged: true, test: null };
  redis.run(["SET", `nl:mail:bc:${b.id}`, JSON.stringify(b)]);
  return b;
}
const settle = () => new Promise((r) => setTimeout(r, 200));
const isGrantSet = (commands: (string | number)[][]) =>
  commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:letters:link:") && !String(commands[0][1]).endsWith(":opens");
const tokenOf = (text: string | undefined) => /token=([0-9a-f]{64})/.exec(text ?? "")?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Mara's Club", "");
  await ensureStatsId(OWNER); await ensureStoreId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: `cus_${HANDLE}`, subscriptionId: `sub_${HANDLE}`, active: true, tier: "pro", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1TestLetterGr", true);
  const made = await addProduct(OWNER, "Butter Club", "", "49", null);
  if (!made.ok) throw new Error("no product");
  club = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const published = await publishLetter(store, broadcast(store, "b1"), Date.now(), [club]);
  if (!published.ok) throw new Error(published.message);
  const letter: Letter = published.letter;
  let n = 0;
  const ask = (email: string) => requestLetterLink({ store, letter, email, ip: `203.0.113.${10 + ++n}`, origin: "https://marktmorgen.com" });
  const used = async () => allowanceUsed((await storeForEmail(OWNER))!, "transactional");

  part("control: an answered SET emails a link that opens, and takes one email from the allowance");
  const usedBefore = await used();
  is("asked", await ask("member1@example.com"), "sent");
  await settle();
  const first = tokenOf(mails.at(-1)?.text);
  is("emailed with a token", [mails.length, first.length], [1, 64]);
  is("the token reads its grant", (await readLetterGrant(first))?.l, letter.id);
  is("one transactional email taken", (await used()) - usedBefore, 1);

  part("the grant's SET reply in any other shape: no email, no allowance taken, said in the log");
  const real = redis.pipeline.bind(redis);
  const shapes: [string, unknown][] = [
    ["no reply", []],
    ["undefined", [undefined]],
    ["a hole", new Array(1)],
    ["QUEUED", ["QUEUED"]],
    ["null", [null]],
    ["lower-case ok", ["ok"]],
    ["a number", [1]],
    ["an error object", [new Error("WRONGTYPE")]],
    ["two replies", ["OK", "OK"]],
    ["not a list", "OK"],
  ];
  let member = 1;
  for (const [label, shape] of shapes) {
    const email = `member${++member}@example.com`;
    const mailsBefore = mails.length;
    const callsBefore = resendCalls;
    const allowanceBefore = await used();
    const logsBefore = logged.length;
    redis.pipeline = (async (commands: (string | number)[][]) => (isGrantSet(commands) ? shape : real(commands))) as typeof redis.pipeline;
    is(`${label}: the form's answer is unchanged`, await ask(email), "sent");
    await settle();
    redis.pipeline = real;
    is(`${label}: no email went out`, [mails.length - mailsBefore, resendCalls - callsBefore], [0, 0]);
    is(`${label}: nothing taken from the store's transactional allowance`, (await used()) - allowanceBefore, 0);
    is(`${label}: the server's log says the link was not sent`, logged.slice(logsBefore).some((line) => /link to read an email/.test(line)), true);
  }

  part("a pipeline that throws on the grant's SET: no email, no allowance taken");
  {
    const mailsBefore = mails.length;
    const allowanceBefore = await used();
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (isGrantSet(commands)) throw new Error("connection reset");
      return real(commands);
    }) as typeof redis.pipeline;
    is("thrown: the form's answer is unchanged", await ask(`member${++member}@example.com`), "sent");
    await settle();
    redis.pipeline = real;
    is("thrown: no email went out", mails.length - mailsBefore, 0);
    is("thrown: nothing taken from the allowance", (await used()) - allowanceBefore, 0);
  }

  part("asking again after a failed SET emails a link that opens");
  {
    const email = `member${++member}@example.com`;
    redis.pipeline = (async (commands: (string | number)[][]) => (isGrantSet(commands) ? [] : real(commands))) as typeof redis.pipeline;
    await ask(email);
    await settle();
    redis.pipeline = real;
    const mailsBefore = mails.length;
    const allowanceBefore = await used();
    is("asked again", await ask(email), "sent");
    await settle();
    const token = tokenOf(mails.at(-1)?.text);
    is("emailed once, with a token", [mails.length - mailsBefore, token.length], [1, 64]);
    is("the new link opens", (await readLetterGrant(token))?.l, letter.id);
    is("one transactional email taken", (await used()) - allowanceBefore, 1);
  }

  console.error = realError;
  done();
}
main().catch((error) => { console.error = realError; console.error(error); process.exit(1); });
