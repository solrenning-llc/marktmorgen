/**
 * Notices and takedowns (lib/takedown-rules.ts, lib/takedown.ts; added 9
 * October 2026). Checked: a copyright notice needs each thing the DMCA asks
 * of it, another notice a little less; a notice is kept and sent to the
 * support inbox only — never to the address typed — with a link that opens
 * it; that link touches only the store it names; each takedown is written
 * on the store's record and emailed to the creator; and a store switched off
 * sells nothing and shows no sign-up box until it is back on. A notice is
 * counted on the public transparency page only once it reached the inbox: a
 * try that failed to send, and is sent again, never counts twice.
 */
import { addProduct, addStoreLink, claimHandle, ensureStatsId, setJoin, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport, reportedProduct, takeDown } from "@/lib/takedown";
import { canSell } from "@/lib/store-checkout";
import { transparencyCounts } from "@/lib/transparency";
import { KIND } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[] | string; subject: string; text: string; reply_to?: string };
const sent: Sent[] = [];
let senderDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (senderDown) return new Response(JSON.stringify({ message: "unavailable" }), { status: 500 });
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const NOTICE = {
  kind: "copyright",
  url: "https://marktmorgen.com/@noticeshop",
  work: "My song 'Harbor Lights', played on this page from a SoundCloud upload I did not make.",
  original: "https://example.com/harbor-lights",
  name: "Rita Owner",
  email: "rita@example.com",
  contact: "+1 555 0100",
  signature: "Rita Owner",
  goodFaith: true,
  accurate: true,
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";

  part("What a notice must say");
  is("a whole copyright notice is read", readReport(NOTICE).ok, true);
  is("each missing part is named", [
    readReport({ ...NOTICE, kind: "spam" }),
    readReport({ ...NOTICE, url: "my store" }),
    readReport({ ...NOTICE, work: "mine" }),
    readReport({ ...NOTICE, email: "rita@" }),
    readReport({ ...NOTICE, contact: "" }),
    readReport({ ...NOTICE, signature: "" }),
    readReport({ ...NOTICE, accurate: false }),
  ].map((r) => (r.ok ? "ok" : r.problem)), ["kind", "url", "work", "email", "contact", "signature", "statements"]);
  is("another kind of notice needs no address or telephone", readReport({ ...NOTICE, kind: "other", contact: "" }).ok, true);

  part("Kept, and sent to the support inbox only");
  const owner = "notice@example.com";
  await claimHandle(owner, "noticeshop", "Notice Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestNotice0001", true);
  await setSubscription(owner, { customerId: "cus_Notice001", subscriptionId: "sub_Notice001", active: true, period: paidPeriod() });
  const link = await addStoreLink(owner, "My mixtape", "https://soundcloud.com/someone/a-track");
  const made = await addProduct(owner, "Song Pack", "", "9", null);
  if (!link.ok || !made.ok) throw new Error("setup");
  await setJoin(owner, { on: true });
  const read = readReport(NOTICE);
  if (!read.ok) throw new Error("notice");
  is("sent", await fileReport(read.report, "9.9.9.9", "https://marktmorgen.com"), "sent");
  const mail = sent[0];
  is("to the support inbox, with Reply to the sender, and nothing to the sender", [[mail.to].flat(), mail.reply_to, sent.length], [["support@marktmorgen.com"], "rita@example.com", 1]);
  is("saying everything the notice said", [mail.subject, mail.text.includes("Harbor Lights"), mail.text.includes("+1 555 0100"), mail.text.includes("under penalty of perjury")], ["Copyright notice about @noticeshop", true, true, true]);
  const token = mail.text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const opened = await openReport(token);
  is("its link opens it, with the store it names", [opened?.report.name, opened?.store?.handle], ["Rita Owner", "noticeshop"]);
  is("a token that is not one opens nothing", [await openReport("0".repeat(48)), await openReport("nope")], [null, null]);
  for (let i = 0; i < 4; i++) await fileReport(read.report, "9.9.9.9", "https://marktmorgen.com");
  is("five an hour from one connection", await fileReport(read.report, "9.9.9.9", "https://marktmorgen.com"), "limited");
  const received = async () => (await transparencyCounts()).years[0]?.notices.copyright ?? 0;
  is("each notice that reached the inbox is counted once", await received(), 5);
  senderDown = true;
  const tries = [await fileReport(read.report, "8.8.8.8", "https://marktmorgen.com"), await fileReport(read.report, "8.8.8.8", "https://marktmorgen.com")];
  senderDown = false;
  is("two tries that could not be sent: an error each, and nothing more counted", [tries, (await received()) - 5], [["error", "error"], 0]);

  is("a notice about a product's page points at that product", (await reportedProduct({ ...opened!.report, url: `https://marktmorgen.com/@noticeshop/p/${made.product.id}` }, (await storeForEmail(owner))!))?.id, made.product.id);

  part("Taken down, written down, and told");
  sent.length = 0;
  const report = opened!.report;
  const store = () => storeForEmail(owner).then((s) => s!);
  is("a link removed", await takeDown(report, await store(), { type: "link", id: link.store.links[0].id }, "https://marktmorgen.com"), 'The link "My mixtape" (https://soundcloud.com/someone/a-track)');
  is("gone from the page, and on the record", [(await store()).links.length, (await store()).strikes.length, (await store()).strikes[0].report], [0, 1, report.id]);
  is("the creator is told what, why, and how to answer", [[sent[0].to].flat(), sent[0].text.includes("Harbor Lights"), sent[0].text.includes("counter-notice")], [["notice@example.com"], true, true]);
  is("a product unpublished", [await takeDown(report, await store(), { type: "product", id: made.product.id }, "https://marktmorgen.com"), ((await store()).catalog.items.find((p) => p.id === made.product.id)?.kind ?? 0) & KIND.hidden], ['The product "Song Pack", now unpublished', KIND.hidden]);
  is("nothing twice", await takeDown(report, await store(), { type: "link", id: link.store.links[0].id }, "https://marktmorgen.com"), null);

  part("A store switched off");
  is("before: it sells", canSell(await store()), true);
  await takeDown(report, await store(), { type: "store", on: true }, "https://marktmorgen.com");
  const off = await store();
  is("its pages and sales off, and on the record", [Boolean(off.suspended), canSell(off), off.strikes.length], [true, false, 3]);
  await takeDown(report, off, { type: "store", on: false }, "https://marktmorgen.com");
  is("and back on, with the record kept", [(await store()).suspended, canSell(await store()), (await store()).strikes.length], ["", true, 3]);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
