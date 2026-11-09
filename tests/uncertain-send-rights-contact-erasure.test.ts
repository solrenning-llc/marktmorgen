/**
 * A store's contact message and a deletion link whose send is not known (audit "envio incerto", 9 November 2026;
 * rule 30): sendEmail answers false also when the sender may have taken the email (a server error, a timeout).
 *
 *   lib/store-contact.ts:57: an uncertain email to the creator still files the message in the studio's inbox (it used
 *     to be filed only when the email was confirmed, so the message could be lost), and the visitor is told it is
 *     kept, not to send it again. A certain refusal stays "error", filed nowhere, as before.
 *   lib/erasure-request.ts:208: an uncertain deletion link keeps its link alive (it used to be deleted, so a link that
 *     reached the person did not work) and no other store is asked to send a second one. A certain refusal deletes
 *     the link, as before.
 *
 * Synthetic stores, in-memory Redis, the email provider stood in by fetch. No network.
 */
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setContact, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { sendContact } from "@/lib/store-contact";
import { CONTACT_WORDS } from "@/lib/buyer-words/contact";
import { readInbox } from "@/lib/inbox";
import { rememberBuyers } from "@/lib/buyer-library";
import { askErasureLink, readErasureLink } from "@/lib/erasure-request";
import { takeAllowance, allowanceUsed } from "@/lib/store-allowance";
import { allowanceFor, askedCeiling } from "@/lib/store-allowance-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Mail = { to: string[] | string; subject: string; text: string };
const asked: Mail[] = [];
let sender: "ok" | "uncertain" | "refused" = "ok";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    asked.push(JSON.parse(String(init?.body)) as Mail);
    if (sender === "uncertain") return new Response(JSON.stringify({ message: "internal" }), { status: 500 });
    if (sender === "refused") return new Response(JSON.stringify({ message: "invalid" }), { status: 422 });
    return new Response(JSON.stringify({ id: `email_${asked.length}` }));
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
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

/** Leaves exactly one email of the store's share for visitors' confirmations. */
async function leaveOne(store: Store): Promise<void> {
  const share = askedCeiling(allowanceFor(store, "transactional")) - (await allowanceUsed(store, "transactional"));
  if (share > 1 && !(await takeAllowance(store, "transactional", share - 1, Date.now(), true)).ok) throw new Error("could not fill");
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 300));

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_timing_only_a_stand_in";

  part("A contact message whose email may have gone is filed in the inbox (lib/store-contact.ts:57)");
  {
    const owner = "owner@contact-unsure.example";
    await paidStore("contact-unsure");
    await setContact(owner, { on: true });
    const store = (await storeForEmail(owner))!;
    const message = "Hello! Could we work together on a cookbook for a magazine?";
    sender = "uncertain";
    const result = await sendContact({ store, name: "Dana", email: "dana@example.com", message, ip: "1.1.1.1" });
    sender = "ok";
    is("said as kept, never as an error to send again", result, "kept");
    is("the message is in the creator's inbox", JSON.stringify(await readInbox(store.statsId!)).includes("dana@example.com"), true);
    for (const [language, words] of Object.entries(CONTACT_WORDS)) {
      is(`${language}: words for a kept message and for one not confirmed`, [Boolean(words.notices.kept?.title), Boolean(words.notices.unsure?.title)], [true, true]);
    }
    is("the English says not to send it again", CONTACT_WORDS.en.notices.kept?.body.includes("Please do not send it again") ?? false, true);

    sender = "refused";
    const refused = await sendContact({ store, name: "Lee", email: "lee@example.com", message: "A second, different question about the cookbook pages.", ip: "2.2.2.2" });
    sender = "ok";
    is("control: a certain refusal stays an error and is not filed", [refused, JSON.stringify(await readInbox(store.statsId!)).includes("lee@example.com")], ["error", false]);
  }

  part("A deletion link that may have gone stays alive, and no other store sends a second (lib/erasure-request.ts:208)");
  {
    const first = await paidStore("erase-unsure-a");
    const second = await paidStore("erase-unsure-b");
    const address = "person-unsure@example.com";
    await rememberBuyers(first.sid, [address]);
    await rememberBuyers(second.sid, [address]);
    // The first store has one email left of its share: the uncertain send takes it, so its share reads full after.
    await leaveOne((await storeForEmail("owner@erase-unsure-a.example"))!);
    await leaveOne((await storeForEmail("owner@erase-unsure-b.example"))!);
    asked.length = 0;
    sender = "uncertain";
    await askErasureLink({ email: address, ip: "198.51.100.9", origin: "https://marktmorgen.com" });
    await settled();
    sender = "ok";
    is("one deletion link asked for, never a second from another store", asked.filter((m) => [m.to].flat().includes(address)).length, 1);
    const token = asked[0]?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
    is("the link in that email still works", Boolean(token) && (await readErasureLink(token)) !== null, true);

    redis.clear();
    const third = await paidStore("erase-refused");
    await rememberBuyers(third.sid, ["person-refused@example.com"]);
    asked.length = 0;
    sender = "refused";
    await askErasureLink({ email: "person-refused@example.com", ip: "198.51.100.10", origin: "https://marktmorgen.com" });
    await settled();
    sender = "ok";
    const refusedToken = asked[0]?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
    is("control: a certain refusal lets the link go", [asked.length, Boolean(refusedToken) && (await readErasureLink(refusedToken)) === null], [1, true]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
