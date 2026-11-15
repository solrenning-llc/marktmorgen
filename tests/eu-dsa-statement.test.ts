/**
 * The statement of reasons a creator is emailed when we take content down
 * (lib/takedown.ts, `takeDown`), held to EU Digital Services Act Art. 17(3),
 * element by element (EU consumer audit, unit u11, 6 November 2026):
 *   (a) what was restricted, where (territorial scope) and for how long;
 *   (b) the facts relied on, and that it came from a notice (Art. 16); the
 *       person who sent a notice of illegal content is not named;
 *   (c) whether automated means were used: none are (a person presses a
 *       button on app/takedown/[token], components/takedown-actions.tsx);
 *   (d) the legal ground relied on, with the explanation;
 *   (e) the contractual ground: the Terms sections that do not allow it,
 *       each a real section of app/terms/page.tsx, linked by its anchor;
 *   (f) redress: how to answer us, and that a court can be asked (judicial
 *       redress, with the Terms' governing-law section). No internal
 *       complaint-handling system (Art. 20) and no out-of-court dispute
 *       settlement body (Art. 21) is promised: the code offers neither.
 * The email has a text part only, so the text is what is checked.
 */
import { readFileSync } from "node:fs";
import { sectionId } from "@/components/legal-page";
import { addProduct, addStoreLink, claimHandle, ensureStatsId, setKit, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport, takeDown } from "@/lib/takedown";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[] | string; subject: string; text: string; html?: string };
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
  kind: "copyright",
  url: `${ORIGIN}/@dsashop`,
  work: "My song 'Harbor Lights', played on this page from a SoundCloud upload I did not make.",
  original: "https://example.com/harbor-lights",
  name: "Rita Notifier",
  email: "rita@example.com",
  contact: "+1 555 0100",
  signature: "Rita Notifier",
  goodFaith: true,
  accurate: true,
};

// The Terms' section anchors, computed as components/legal-page.tsx computes them.
const terms = readFileSync("app/terms/page.tsx", "utf8");
const anchorOf = (title: string) => title.toLowerCase().replace(/^\d+\.\s*/, "").replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const SECTIONS = ["3. Selling through a Marktmorgen store", "4. Acceptable use", "16. Governing law"];
// What each kind of action is said to last, as the code makes it last.
const DURATION: Record<Taken, string> = {
  product: `How long: until you publish it again. Publishing it again while the notice stands may lead us to suspend your store (Terms, section 3, ${ORIGIN}/terms#selling-through-a-marktmorgen-store).`,
  link: "How long: for good. The link and its file are deleted, so there is nothing to put back.",
  kit: `How long: until you switch it on again. Switching it on again while the notice stands may lead us to suspend your store (Terms, section 3, ${ORIGIN}/terms#selling-through-a-marktmorgen-store).`,
  store: "How long: until we switch your store back on, for example after your answer below.",
};

type Taken = "product" | "link" | "kit" | "store";
async function emailFor(kind: "copyright" | "other", handle: string, taken: Taken = "product"): Promise<string> {
  const owner = `${handle}@example.com`;
  await claimHandle(owner, handle, "DSA Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, `acct_1Test${handle.slice(0, 8)}0001`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, period: paidPeriod() });
  const link = await addStoreLink(owner, "My mixtape", "https://soundcloud.com/someone/a-track");
  const made = await addProduct(owner, "Song Pack", "", "9", null);
  if (!link.ok || !made.ok) throw new Error("setup");
  const read = readReport({ ...NOTICE, kind, url: `${ORIGIN}/@${handle}`, contact: kind === "copyright" ? NOTICE.contact : "" });
  if (!read.ok) throw new Error("notice");
  sent.length = 0;
  if ((await fileReport(read.report, `9.9.9.${kind.length}`, ORIGIN)) !== "sent") throw new Error("filed");
  const token = sent[0].text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  const opened = await openReport(token);
  if (!opened?.store) throw new Error("opened");
  sent.length = 0;
  if (taken === "kit") await setKit(owner, { ...(await storeForEmail(owner))!.kit, on: true });
  const store = (await storeForEmail(owner))!;
  if (taken === "kit" && !store.kit.on) throw new Error("the media kit did not switch on");
  await takeDown(opened.report, store, taken === "product" ? { type: "product", id: made.product.id } : taken === "link" ? { type: "link", id: store.links.find((l) => l.title === "My mixtape")!.id } : taken === "kit" ? { type: "kit" } : { type: "store", on: true }, ORIGIN);
  const mail = sent.find((m) => [m.to].flat().includes(owner));
  if (!mail) throw new Error("no email to the creator");
  is(`${kind}: the email has no HTML part to check apart from its text`, mail.html ?? null, null);
  return mail.text;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";

  part("The Terms sections the email cites exist");
  is("each section title is in app/terms/page.tsx", SECTIONS.map((t) => terms.includes(`title="${t}"`)), [true, true, true]);
  is("the takedown is decided by a person pressing a button", readFileSync("components/takedown-actions.tsx", "utf8").includes('fetch("/api/takedown"'), true);

  for (const kind of ["copyright", "other"] as const) {
    const text = await emailFor(kind, kind === "copyright" ? "dsacopy" : "dsaother");
    part(`Art. 17(3), a ${kind} notice`);
    is("(a) what was restricted", text.includes('The product "Song Pack", now unpublished'), true);
    is("(a) territorial scope: every country", text.includes("Where: everywhere. It is down for every visitor, in every country."), true);
    // Claude 5's MEDIUM on #2928: the creator can publish a product again at once, so "only we change it" was untrue.
    is("(a) duration of a product: until it is published again, and what that risks", text.includes(DURATION.product), true);
    is("(a) no promise that only we can change it", text.includes("We change it only if we decide to"), false);
    is("(b) facts: the notice and the address it named", [text.includes(`${ORIGIN}/@dsa`), text.includes("Harbor Lights")], [true, true]);
    is("(b) that it came from a notice, under which rule", text.includes(kind === "copyright"
      ? `What we relied on: that notice, sent through our form at ${ORIGIN}/report as a copyright notice under the US Digital Millennium Copyright Act (17 U.S.C. § 512(c)(3)).`
      : `What we relied on: that notice, sent through our form at ${ORIGIN}/report as a notice of illegal content under Article 16 of the EU Digital Services Act.`), true);
    is("(b) the sender of a notice of illegal content is not named", text.includes("Rita Notifier"), kind === "copyright");
    is("(c) no automated means", text.includes("We used no automated means to find this content or to decide: a person at Marktmorgen read the notice and made this decision."), true);
    is("(d) the legal ground, with why", text.includes(kind === "copyright"
      ? "Legal ground: copyright law. The notice says the content infringes the copyright in the work it names, and we took it down for that reason."
      : "Legal ground: the law the notice says the content breaks, for the reason it gives above. We took it down for that reason."), true);
    is("(e) the contractual ground: Terms sections 3 and 4, linked", [
      text.includes("Our Terms do not allow content that is unlawful or that infringes someone else's rights:"),
      text.includes(`section 3, "Selling through a Marktmorgen store" (${ORIGIN}/terms#${anchorOf(SECTIONS[0])})`),
      text.includes(`section 4, "Acceptable use" (${ORIGIN}/terms#${anchorOf(SECTIONS[1])})`),
    ], [true, true, true]);
    is("(f) how to answer us", text.includes(kind === "copyright" ? "counter-notice" : "reply to this email and say why"), true);
    is("(f) judicial redress", text.includes(`You can also take our decision to a court. Section 16 of our Terms, "Governing law", says which law and courts apply (${ORIGIN}/terms#${anchorOf(SECTIONS[2])}).`), true);
    is("(f) no internal complaint system or out-of-court body promised", /complaint-handling|Article 20|Article 21|out-of-court/i.test(text), false);
  }
  part("Art. 17(3)(a), the duration said for each kind of action (Claude 5 on #2928)");
  for (const taken of ["link", "kit", "store"] as const) {
    const text = await emailFor("other", `dsa${taken}x`, taken);
    is(`${taken}: the duration says what the code does`, text.includes(DURATION[taken]), true);
    is(`${taken}: no other kind's duration`, (Object.keys(DURATION) as Taken[]).filter((k) => k !== taken).some((k) => text.includes(DURATION[k])), false);
  }

  part("The anchors the email links to are the ones the Terms page draws (Claude 5's LOW 3 on #2928)");
  for (const title of SECTIONS) {
    const line = terms.split("\n").find((l) => l.includes(`title="${title}"`)) ?? "";
    is(`"${title}" has no id of its own, so its anchor is the one computed from its title`, /\bid=/.test(line), false);
    is(`"${title}": the test's anchor is the page's own sectionId`, anchorOf(title), sectionId(title));
  }
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
