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
import { addProduct, addStoreLink, claimHandle, ensureStatsId, setJoin, setProductHidden, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { isTakenDown, makeDraftPreview, readDraftPreview, revokeDraftPreview } from "@/lib/draft-preview";
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

  // Claude 6 on #3439, MEDIUM 1 (and Codex M, review 5833044179): a product taken down after a notice kept opening
  // through a draft preview link, and a notice about a preview address pointed at no product.
  part("A product taken down closes its draft preview");
  const drafted = await addProduct(owner, "Draft Pack", "", "9", null);
  if (!drafted.ok) throw new Error("setup");
  await setProductHidden(owner, drafted.product.id, true);
  const early = await makeDraftPreview(await store(), drafted.product.id);
  const previewNotice = { ...report, url: `https://marktmorgen.com/@noticeshop/preview/${early.code}` };
  is("a notice about its preview address points at that product", (await reportedProduct(previewNotice, await store()))?.id, drafted.product.id);
  is("a preview address of no link points at nothing", await reportedProduct({ ...report, url: `https://marktmorgen.com/@noticeshop/preview/${"B".repeat(22)}` }, await store()), null);
  is("the link opens before", (await readDraftPreview(early.code))?.productId, drafted.product.id);
  await setProductHidden(owner, drafted.product.id, false);
  is("taken down by the real path", await takeDown(report, await store(), { type: "product", id: drafted.product.id }, "https://marktmorgen.com"), 'The product "Draft Pack", now unpublished');
  is("the link made before no longer opens", await readDraftPreview(early.code), null);
  is("the product is marked taken down", await isTakenDown(await store(), drafted.product.id), true);
  const after = await makeDraftPreview(await store(), drafted.product.id);
  is("a link written after it never opens", await readDraftPreview(after.code), null);

  part("A draft still hidden, reported by its preview address, has its preview closed (Claude 6's focal on #3597)");
  const hiddenDraft = await addProduct(owner, "Quiet Draft", "", "9", null);
  if (!hiddenDraft.ok) throw new Error("setup");
  await setProductHidden(owner, hiddenDraft.product.id, true);
  const shared = await makeDraftPreview(await store(), hiddenDraft.product.id);
  const draftNotice = { ...report, url: `https://marktmorgen.com/@noticeshop/preview/${shared.code}` };
  is("its preview address points at the draft", (await reportedProduct(draftNotice, await store()))?.id, hiddenDraft.product.id);
  is("the link opens before", (await readDraftPreview(shared.code))?.productId, hiddenDraft.product.id);
  is(
    "taken down while it stays a draft: its preview link is closed",
    await takeDown(draftNotice, await store(), { type: "product", id: hiddenDraft.product.id }, "https://marktmorgen.com"),
    'The preview link of the draft product "Quiet Draft", now closed',
  );
  is("the link made before no longer opens", await readDraftPreview(shared.code), null);
  is("the draft is marked taken down", await isTakenDown(await store(), hiddenDraft.product.id), true);
  is("it stays a draft", ((await store()).catalog.items.find((p) => p.id === hiddenDraft.product.id)?.kind ?? 0) & KIND.hidden, KIND.hidden);
  const later = await makeDraftPreview(await store(), hiddenDraft.product.id);
  is("a link written after it never opens", await readDraftPreview(later.code), null);
  is("a second press finds nothing more to do", await takeDown(draftNotice, await store(), { type: "product", id: hiddenDraft.product.id }, "https://marktmorgen.com"), null);

  // Revisor 2 on #3597: a draft with no preview link has nothing public to take down. Pressing "Unpublish" on it must
  // stay "nothing to do": no strike towards suspension, no transparency count and no statement of reasons saying a link
  // was closed (EU DSA Art. 17).
  part("A draft with no preview link has nothing to take down (Revisor 2 on #3597)");
  const bare = await addProduct(owner, "Bare Draft", "", "9", null);
  if (!bare.ok) throw new Error("setup");
  await setProductHidden(owner, bare.product.id, true);
  const strikesBefore = (await store()).strikes.length;
  const countedBefore = JSON.stringify(await transparencyCounts(Date.now()));
  sent.length = 0;
  is("a draft never given a link: nothing is done", await takeDown(report, await store(), { type: "product", id: bare.product.id }, "https://marktmorgen.com"), null);
  is("no strike is written", (await store()).strikes.length, strikesBefore);
  is("nothing is counted on the transparency page", JSON.stringify(await transparencyCounts(Date.now())), countedBefore);
  is("the creator is sent nothing", sent.filter((mail) => [mail.to].flat().includes(owner)).length, 0);
  is("and the draft is not marked taken down, so a link can still be made for it", await isTakenDown(await store(), bare.product.id), false);
  const revoked = await addProduct(owner, "Revoked Draft", "", "9", null);
  if (!revoked.ok) throw new Error("setup");
  await setProductHidden(owner, revoked.product.id, true);
  await makeDraftPreview(await store(), revoked.product.id);
  await revokeDraftPreview(await store(), revoked.product.id);
  is("a draft whose link was revoked: nothing is done either", await takeDown(report, await store(), { type: "product", id: revoked.product.id }, "https://marktmorgen.com"), null);
  is("still no strike", (await store()).strikes.length, strikesBefore);

  // Rule 24 (residual LOW of focal L on #3692): the draft's link and its taken-down mark, read in a shape Redis never
  // gives, are unknown, never "no link": the takedown throws, and nothing is written, counted or sent.
  part("A draft's link that does not read is never \"nothing to take down\" (rule 24)");
  const unread = await addProduct(owner, "Unread Draft", "", "9", null);
  if (!unread.ok) throw new Error("setup");
  await setProductHidden(owner, unread.product.id, true);
  await makeDraftPreview(await store(), unread.product.id);
  const countedUnread = JSON.stringify(await transparencyCounts(Date.now()));
  sent.length = 0;
  const realPipeline = redis.pipeline;
  redis.pipeline = async (commands: (string | number)[][]) =>
    commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:dpv:p:")) ? commands.map(() => ({ unexpected: true })) : realPipeline.call(redis, commands);
  let threw = "";
  try {
    await takeDown(report, await store(), { type: "product", id: unread.product.id }, "https://marktmorgen.com");
  } catch (error) {
    threw = (error as Error).message;
  } finally {
    redis.pipeline = realPipeline;
  }
  is("the takedown throws that the link could not be read, never answers \"nothing to do\"", /preview link .*could not be read/.test(threw), true);
  is("no strike is written", (await store()).strikes.length, strikesBefore);
  is("nothing is counted", JSON.stringify(await transparencyCounts(Date.now())), countedUnread);
  is("the creator is sent nothing", sent.filter((mail) => [mail.to].flat().includes(owner)).length, 0);
  is("the draft is not marked taken down", await isTakenDown(await store(), unread.product.id), false);
  is("control: read again, its link is open, and the takedown closes it", (await takeDown(report, await store(), { type: "product", id: unread.product.id }, "https://marktmorgen.com")) !== null, true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
