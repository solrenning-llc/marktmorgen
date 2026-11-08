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
import { store as redis } from "../../../tests/redis-stub";
import { done, is, part } from "../../../tests/check";
import { paidPeriod } from "../../../tests/billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_letter_link_grant_set";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
const OWNER = "letter-link-grant@example.com";
const HANDLE = "maragrant";
const NOW = Math.floor(Date.now() / 1000);
let club = "";
const mails: { to: string; text: string }[] = [];
let resendCalls = 0;
const allowanceAtPosts: number[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    resendCalls += 1;
    const charged = await allowanceUsed((await storeForEmail(OWNER))!, "transactional");
    allowanceAtPosts.push(charged);
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


  part("independent: the producer SET really lands before its receipt is lost or malformed");
  const real = redis.pipeline.bind(redis);
  const cases: [string, (reply: unknown[]) => unknown, boolean][] = [
    ["committed then empty ACK", () => [], false],
    ["committed then extra ACK", () => ["OK", "OK"], false],
    ["committed then nil ACK", () => [null], false],
    ["committed then getter ACK", () => Object.defineProperty([], "0", { get: () => { getterReads += 1; return "OK"; } }), false],
    ["committed then thrown ACK", () => { throw new Error("synthetic reply lost after committed SET"); }, false],
    ["committed frozen exact ACK", reply => Object.freeze(reply), true],
  ];
  let getterReads = 0, member = 80;
  for (const [label, replace, accepted] of cases) {
    const beforeMail=mails.length, beforePosts=resendCalls, beforeAllowance=await used(), beforeLogs=logged.length;
    const counts=() => (globalThis as unknown as { __zCounts(): { runs:number; mocks:number } }).__zCounts();
    const beforeCount=counts();
    let grantKey="", grantSets=0, commandBytes=0;
    redis.pipeline = (async (commands: (string|number)[][]) => {
      commandBytes += Buffer.byteLength(JSON.stringify(commands));
      const reply=await real(commands);
      if (isGrantSet(commands)) {
        grantKey=String(commands[0][1]); grantSets += 1;
        return replace(reply);
      }
      return reply;
    }) as typeof redis.pipeline;
    is(label+": asynchronous form answer remains sent", await ask(`member${++member}@example.com`), "sent");
    await settle();
    redis.pipeline=real;
    const afterAllowance=await used(), stored=redis.run(["GET",grantKey]);
    is(label+": actual producer kept exactly one grant", [grantSets,typeof stored], [1,"string"]);
    is(label+": email dispatch follows confirmed receipt", [mails.length-beforeMail,resendCalls-beforePosts], accepted?[1,1]:[0,0]);
    is(label+": transactional allowance follows confirmed receipt", afterAllowance-beforeAllowance, accepted?1:0);
    if(accepted){
      const token=tokenOf(mails.at(-1)?.text);
      is(label+": actual emailed token reads the persisted grant", (await readLetterGrant(token))?.l,letter.id);
      is(label+": meter was already consumed at provider POST",allowanceAtPosts.at(-1),afterAllowance);
    } else if(!label.includes("thrown")) {
      is(label+": exact grant-refusal diagnostic",logged.slice(beforeLogs).some(line=>line.includes("grant was not confirmed kept")),true);
    } else {
      is(label+": asynchronous failure is caught and logged",logged.slice(beforeLogs).some(line=>line.includes("sending a link to read an email failed")),true);
    }
    const afterCount=counts();
    console.log("Z_CASE",JSON.stringify({label,grantSets,storedBytes:typeof stored==='string'?Buffer.byteLength(stored):null,pipelineSerializedBytes:commandBytes,runs:afterCount.runs-beforeCount.runs,mocks:afterCount.mocks-beforeCount.mocks,emails:mails.length-beforeMail,allowance:afterAllowance-beforeAllowance}));
  }
  is("getter ACK is refused without executing its slot",getterReads,0);
  console.error=realError;
  done();
}
main().catch(error=>{console.error=realError;console.error(error);process.exitCode=1});
