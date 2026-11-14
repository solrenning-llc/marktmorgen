/**
 * 646 [WG6] HIGH on #3612 @0e070fb08: a notice's link (a 48-hex bearer token) decides the creator's request to look
 * again and shows the notifier's name, email and address. It must never go out in an email whose Reply-To is someone
 * outside the company, because a person pressing Reply quotes the email, link included, to that person. Real
 * fileReport, fileAppeal and sendAgain on the in-memory Redis with a stubbed email provider; synthetic stores only.
 * Fails on: the notice email with Reply-To the notifier, the request's inbox email with Reply-To the creator, and an
 * email that drops the address the person needs to write to them in a new email.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport, takeDown } from "@/lib/takedown";
import { decisionsOf, fileAppeal, sendAgain } from "@/lib/takedown-appeals";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[] | string; subject: string; text: string; reply_to?: string | string[] };
const sent: Sent[] = [];
let mailDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (mailDown) return new Response(JSON.stringify({ message: "down" }), { status: 500 });
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const LINK = /\/takedown\/[0-9a-f]{48}/;
const NOTIFIER = "notifier@example.test";

/** The Reply-To of an email that carries a notice's link: only none or the support inbox is safe. */
const linkReplyTos = () => sent.filter((m) => LINK.test(m.text)).map((m) => [m.reply_to ?? []].flat().join(",") || "none");
const safe = (replyTos: string[]) => replyTos.length > 0 && replyTos.every((r) => r === "none" || r === SUPPORT_EMAIL);

async function main() {
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";
  redis.clear();
  const handle = "replytoshop";
  const owner = `${handle}@example.test`;
  await claimHandle(owner, handle, "Synthetic shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestRepl01", true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic Guide", "", "9", null);
  if (!made.ok) throw new Error("setup");
  const read = readReport({
    kind: "copyright", url: `${ORIGIN}/@${handle}`, work: "A synthetic work named in a synthetic notice.", original: "https://example.test/work",
    name: "Synthetic Notifier", email: NOTIFIER, contact: "+1 555 0100", signature: "Synthetic Notifier", goodFaith: true, accurate: true,
  });
  if (!read.ok) throw new Error("notice");

  part("The notice email carries the link, so a Reply never reaches the notifier");
  sent.length = 0;
  is("filed", await fileReport(read.report, "9.9.1.1", ORIGIN), "sent");
  is("its Reply-To is none or the support inbox", safe(linkReplyTos()), true);
  is("it still gives the notifier's address to write to in a new email", sent[0]?.text.includes(NOTIFIER), true);
  is("it never tells the reader to reply to answer the sender", /reply to this email to answer/i.test(sent[0]?.text ?? ""), false);

  const token = sent[0].text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const opened = await openReport(token);
  if (!opened?.store) throw new Error("opened");
  await takeDown(opened.report, opened.store, { type: "product", id: made.product.id }, ORIGIN);
  const store = (await storeForEmail(owner))!;
  const decision = decisionsOf(store).find((d) => d.report === opened.report.id)!;

  part("The request's inbox email carries a new link, so a Reply never reaches the creator");
  sent.length = 0;
  const filed = await fileAppeal(store, decision.key, { explanation: "I made this guide myself." }, new Date(), ORIGIN);
  is("filed and told", filed.ok && filed.kept.told, true);
  const inbox = sent.filter((m) => [m.to].flat().includes(SUPPORT_EMAIL));
  is("the inbox email has the link", inbox.some((m) => LINK.test(m.text)), true);
  is("its Reply-To is none or the support inbox", safe(linkReplyTos()), true);
  is("it still gives the creator's address to write to in a new email", inbox.some((m) => m.text.includes(owner)), true);
  is("it never tells the reader to reply to answer the creator", inbox.some((m) => /repl(y|ying) to this email/i.test(m.text)), false);

  part("Send it again, after an email that did not go, keeps the same rule");
  const owner2 = "replytoshop2@example.test";
  await claimHandle(owner2, "replytoshop2", "Synthetic shop", "");
  await ensureStatsId(owner2);
  await ensureStoreId(owner2);
  await setStripeAccount(owner2, "acct_1TestRepl02", true);
  await setSubscription(owner2, { customerId: "cus_replytoshop2", subscriptionId: "sub_replytoshop2", active: true, period: paidPeriod() });
  const made2 = await addProduct(owner2, "Synthetic Guide", "", "9", null);
  if (!made2.ok) throw new Error("setup 2");
  const read2 = readReport({ ...read.report, url: `${ORIGIN}/@replytoshop2` });
  if (!read2.ok) throw new Error("notice 2");
  sent.length = 0;
  await fileReport(read2.report, "9.9.1.2", ORIGIN);
  const opened2 = await openReport(sent[0].text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "");
  if (!opened2?.store) throw new Error("opened 2");
  await takeDown(opened2.report, opened2.store, { type: "product", id: made2.product.id }, ORIGIN);
  const store2 = (await storeForEmail(owner2))!;
  const decision2 = decisionsOf(store2).find((d) => d.report === opened2.report.id)!;
  mailDown = true;
  const unsent = await fileAppeal(store2, decision2.key, { explanation: "Mine." }, new Date(), ORIGIN);
  is("the first email did not go", unsent.ok && unsent.kept.told, false);
  mailDown = false;
  sent.length = 0;
  const again = await sendAgain(store2, decision2.key, ORIGIN);
  is("sent again", again?.ok && again.kept.told, true);
  is("its Reply-To is none or the support inbox", safe(linkReplyTos()), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
