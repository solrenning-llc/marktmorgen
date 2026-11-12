/**
 * 568 [GD2] (j), the rest after the reserved names (#1533): the report page
 * gains "Impersonation", a notice that a store or page pretends to be
 * someone else, and such a notice goes through the same mechanism as every
 * other: kept, sent to the support inbox with a link to act on it, taken
 * down by a person, a strike on the store's record (the repeat-infringer
 * rule of /copyright), counted on the transparency page, and a statement of
 * reasons to the creator (EU DSA Art. 17(3), as tests/eu-dsa-statement.test.ts
 * holds for the other kinds) that does not name the sender.
 *
 * What fails here:
 *   - the form or the reading of a notice without the reason;
 *   - an impersonation notice that asks for what only a copyright notice
 *     must give (a postal address or telephone number);
 *   - its emails, its page or its statement of reasons calling it a
 *     copyright notice or a notice of illegal content;
 *   - a takedown on it that leaves no strike, or a statement that names
 *     the sender or lacks the ground, the Terms and the redress;
 *   - the transparency page not counting it.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { NOTICE_TITLE, REPORT_KINDS, readReport } from "@/lib/takedown-rules";
import { fileReport, openReport, takeDown } from "@/lib/takedown";
import { NOTICE_KINDS, transparencyCounts } from "@/lib/transparency";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[] | string; subject: string; text: string };
const sent: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const NOTICE = {
  kind: "impersonation",
  url: `${ORIGIN}/@fakebakery`,
  work: "This store uses my bakery's name, logo and my own photos, and tells buyers it is me. It is not.",
  original: "",
  name: "Paula Baker",
  email: "paula@example.com",
  contact: "",
  signature: "Paula Baker",
  goodFaith: true,
  accurate: true,
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";

  part("The reason is offered and read");
  is("a kind of its own", REPORT_KINDS.includes("impersonation" as never), true);
  const read = readReport(NOTICE);
  is("a whole notice reads, without the address or telephone a copyright notice must give", read.ok, true);
  is("the transparency figures count it as a kind of its own", NOTICE_KINDS.includes("impersonation" as never), true);
  const form = readFileSync("components/report-form.tsx", "utf8");
  is("the form offers it, in plain words", [form.includes('"impersonation"'), form.includes("Someone pretending to be me or my business")], [true, true]);
  is("the form asks who is impersonated and how", form.includes("Who the page pretends to be, and how it does it"), true);
  is("its own good-faith statement", form.includes("I believe in good faith that the page pretends to be me, my business, or someone I am authorized to act for."), true);
  const page = readFileSync("app/report/page.tsx", "utf8");
  is("the report page says it takes these too", page.includes("pretends to be you or your business"), true);
  const transparency = readFileSync("app/transparency/page.tsx", "utf8");
  is("the transparency page has its row", [transparency.includes("y.notices.impersonation"), transparency.includes("y.acted.impersonation")], [true, true]);

  part("It reaches the support inbox as what it is");
  const owner = "fakebakery@example.com";
  await claimHandle(owner, "fakebakery", "Fake Bakery", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestFakeBak0001", true);
  await setSubscription(owner, { customerId: "cus_fakebakery", subscriptionId: "sub_fakebakery", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Sourdough Class", "", "9", null);
  if (!read.ok || !made.ok) throw new Error("setup");
  sent.length = 0;
  is("sent", await fileReport(read.report, "9.9.9.1", ORIGIN), "sent");
  const inbox = sent[0];
  is("its subject names it", inbox.subject, "Notice of impersonation about @fakebakery");
  is("its body says what it is, and never a copyright notice or illegal content", [inbox.text.includes("A notice of impersonation was sent from"), /copyright notice|notice of illegal content/i.test(inbox.text)], [true, false]);
  is("who it is about, as they say", inbox.text.includes("Who the page pretends to be, and how, as they say:"), true);
  is("the statement the sender made, in their words", inbox.text.includes("They stated, in good faith, that the page pretends to be them, their business or someone they are authorized to act for, and that the notice is accurate."), true);
  const year = new Date().getUTCFullYear();
  is("counted once it reached the inbox", (await transparencyCounts()).years.find((y) => y.year === String(year))?.notices.impersonation, 1);

  part("Taken down by a person, it is a strike and a statement of reasons");
  const token = inbox.text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const opened = await openReport(token);
  if (!opened?.store) throw new Error("opened");
  const takedownPage = readFileSync("app/takedown/[token]/page.tsx", "utf8");
  is("the page to act on it calls it a notice of impersonation", [takedownPage.includes("title={NOTICE_TITLE[report.kind]}"), NOTICE_TITLE.impersonation], [true, "Notice of impersonation"]);
  sent.length = 0;
  await takeDown(opened.report, (await storeForEmail(owner))!, { type: "product", id: made.product.id }, ORIGIN);
  is("the store keeps a strike, as for every valid notice", (await storeForEmail(owner))!.strikes.length, 1);
  is("counted as acted on", (await transparencyCounts()).years.find((y) => y.year === String(year))?.acted.impersonation, 1);
  const mail = sent.find((m) => [m.to].flat().includes(owner));
  const text = mail?.text ?? "";
  is("(a) what: the creator is told it came from an impersonation notice", text.includes(`We received a notice that your store pretends to be someone else about ${ORIGIN}/@fakebakery and took this down:`), true);
  is("(b) what we relied on", text.includes(`What we relied on: that notice, sent through our form at ${ORIGIN}/report as a notice of impersonation.`), true);
  is("(b) the sender is not named", text.includes("Paula Baker"), false);
  is("(b) the notice's words", text.includes("The notice says: This store uses my bakery's name"), true);
  is("(d) the ground, with why", text.includes("Ground: the notice says the content pretends to be the person or business it names, which misleads buyers and infringes that person's rights. We took it down for that reason."), true);
  is("(e) the Terms sections", text.includes("Our Terms do not allow content that is unlawful or that infringes someone else's rights:"), true);
  is("(f) how to answer us, and no counter-notice under copyright law", [text.includes("reply to this email and say why"), text.includes("counter-notice")], [true, false]);
  is("never called a copyright notice or illegal content", /copyright notice|notice that content on your store is illegal|Digital Millennium/i.test(text), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
