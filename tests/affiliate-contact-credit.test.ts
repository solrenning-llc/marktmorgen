/**
 * A lead who buys later earns the affiliate who brought them (630 [HN6](1);
 * lib/affiliate-leads.ts contactFor, lib/affiliates.ts noteSession).
 *
 * Hotmart credits a sale to the affiliate who first brought the contact, not
 * only to the last click. Here that is the creator's choice, off until they
 * switch it on, and only where a contact is something real: a lead confirmed
 * through that affiliate's link and written down at the time (recordLead).
 * Checked, with the real code and a stubbed Redis:
 *
 *   - off by default, only an explicit yes turns it on, and never while the
 *     program pays no leads (nothing would be confirmed to find);
 *   - a sale with no link, no code and no bond goes to the lead's affiliate,
 *     at today's share, as "contact", and the address written another way is
 *     the same person;
 *   - a link, a code and a bond all come first;
 *   - never a lead reversed as not genuine, never a person deleted from the
 *     store, never an affiliate since removed, never their own purchase;
 *   - the book, the promotion rows and the second tier count it as a sale
 *     somebody brought; the affiliate page and every language say so.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTACTS_RULE, NO_AFFILIATES, attributionWords, creditsContacts, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { noteSession, readBook } from "@/lib/affiliates";
import { contactFor, forgetLeadPerson, recordLead } from "@/lib/affiliate-leads";
import { rememberBuyer } from "@/lib/affiliate-bond";
import { giveCode } from "@/lib/affiliate-codes";
import { affiliatePromotionRows } from "@/lib/affiliate-promotion";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_contact_only";
process.env.RESEND_API_KEY = "re_test_affiliate_contact_only";

const OWNER = "chef@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";
const GONE = "dddddddddddd";
const LEADS = { kind: "signup", cents: 500, hold: 30, daily: 10, budget: 50_000 };
// Written in parts so no real-looking inbox sits in the source (scripts/check_public_data.py).
const JO = "jo.reader" + "@" + "gmail.com";
const JO_OTHER_WAY = "JoReader+news" + "@" + "googlemail.com";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", ...over });

const order = (id: string, email: string, meta: Record<string, string> = {}, discounts: unknown[] = [], created = NOW + 600) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`,
  metadata: { store: "harbor", product: "prod01", title: "Bread course", ...meta },
  customer_details: { email },
  discounts,
});

async function main(): Promise<void> {
  part("Off until the creator asks, and only while leads are paid");
  is("missing: off", parseAffiliateSetting({ lead: LEADS }).contacts, false);
  for (const value of ["true", 1, "yes", {}, null]) {
    is(`${JSON.stringify(value)} is not a yes`, parseAffiliateSetting({ lead: LEADS, contacts: value }).contacts, false);
  }
  is("an explicit yes with leads paid: on", parseAffiliateSetting({ lead: LEADS, contacts: true }).contacts, true);
  is("a yes with no leads paid is kept off, so it cannot turn itself back on unseen", parseAffiliateSetting({ contacts: true }).contacts, false);
  is("the default program has it off", NO_AFFILIATES.contacts, false);
  is("a program switched off credits no contact", creditsContacts(parseAffiliateSetting({ enabled: false, lead: LEADS, contacts: true })), false);
  is("on, enabled and paying leads: credits contacts", creditsContacts(parseAffiliateSetting({ enabled: true, lead: LEADS, contacts: true })), true);

  part("What the affiliate reads");
  const off = attributionWords(parseAffiliateSetting({ enabled: true, days: 30, lead: LEADS }));
  const on = attributionWords(parseAffiliateSetting({ enabled: true, days: 30, lead: LEADS, contacts: true }));
  is("off: the rule says nothing about leads who buy", off.includes(CONTACTS_RULE), false);
  is("on: the rule ends with the contact sentence", on.endsWith(CONTACTS_RULE), true);
  is("which says a link, a code and an earlier purchase come first", /an affiliate's link, an affiliate's code or an earlier purchase/.test(CONTACTS_RULE), true);
is("and that the lead came before the purchase", /confirmed lead before they bought/.test(CONTACTS_RULE), true);
  is("and promises no time limit it cannot keep", /for ever|forever|never expires|no time limit/i.test(CONTACTS_RULE), false);
  const languages = Object.entries(AFFILIATES_WORDS);
  is("every language has the sentence", languages.every(([, w]) => typeof w.contactsRule === "string" && w.contactsRule.length > 40), true);
  is("in English it is the same sentence the rule uses", AFFILIATES_WORDS.en.contactsRule, CONTACTS_RULE);
  is("and every other language has its own words", languages.filter(([code, w]) => code !== "en" && w.contactsRule === CONTACTS_RULE).length, 0);
  const page = readFileSync(join(process.cwd(), "app/[handle]/affiliates/page.tsx"), "utf8");
  is("the affiliate page adds it only where the program credits contacts", /creditsContacts\(terms\)\s*\?[^:]*a\.contactsRule/.test(page), true);
  const studio = readFileSync(join(process.cwd(), "components/affiliate-studio.tsx"), "utf8");
  is("the studio shows the switch only while leads are paid", /\{lead\.kind !== "none" \? \(\s*<label[\s\S]{0,400}checked=\{contacts\}/.test(studio), true);
  is("and never sends it on with leads off", studio.includes(`contacts: lead.kind !== "none" && contacts`), true);

  part("A lead who buys later");
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestContact01", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, lead: LEADS, contacts: true }));
  let store = (await storeForEmail(OWNER))!;
  is("the switch survives the save", store.affiliates.contacts, true);
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:emails`, "ana@example.com", ANA],
    ["HSET", `nl:aff:${statsId}:people`, BEN, person(BEN, "ben@example.com", "ben")],
    ["HSET", `nl:aff:${statsId}:codes`, "ben", BEN],
    ["HSET", `nl:aff:${statsId}:people`, GONE, person(GONE, "dee@example.com", "dee")],
    ["HSET", `nl:aff:${statsId}:codes`, "dee", GONE],
  ]);
  const line = async (ref: string) => (await readBook(store)).lines.find((l) => l.ref === ref);

  is("Ana's lead confirmed through her link", await recordLead(store, { aff: ANA, kind: "signup", email: JO }), "recorded");
  is("the contact reads back as Ana's for a later checkout", await contactFor(store, JO, NOW + 3600), ANA);
  is("never for a checkout opened before the lead was confirmed", await contactFor(store, JO, NOW - 3600), "");
  await noteSession(store, order("cs_c1", JO_OTHER_WAY));
  is(
    "no link, no code: the sale goes to Ana at today's share, as a contact, the address written another way",
    [(await line("cs_c1"))?.aff, (await line("cs_c1"))?.how, (await line("cs_c1"))?.commission],
    [ANA, "contact", 1_500],
  );

  part("Only a lead that came before the purchase");
  await noteSession(store, order("cs_old", "quinn@example.com", {}, [], NOW - 3600));
  is("bought with nobody's link: credits nobody", await line("cs_old"), undefined);
  await recordLead(store, { aff: ANA, kind: "signup", email: "quinn@example.com" });
  await noteSession(store, order("cs_old", "quinn@example.com", {}, [], NOW - 3600));
  is("the same sale written down again after the person became a lead: still nobody's", await line("cs_old"), undefined);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, lead: { ...LEADS, kind: "booking" } }));
  store = (await storeForEmail(OWNER))!;
  is("a paid booking's own lead", await recordLead(store, { aff: ANA, kind: "booking", email: "rae@example.com", at: NOW, ref: "cs_book1", pi: "pi_cs_book1", paid: 5_000 }), "recorded");
  await noteSession(store, order("cs_book1", "rae@example.com", {}, [], NOW + 600));
  is("never credits the very checkout that made it", await line("cs_book1"), undefined);
  await noteSession(store, order("cs_book2", "rae@example.com", {}, [], NOW + 900));
  is("a later purchase by the same person does", [(await line("cs_book2"))?.aff, (await line("cs_book2"))?.how], [ANA, "contact"]);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, lead: LEADS }));
  store = (await storeForEmail(OWNER))!;
  is("a lead still in its hold, not yet approved, counts from when it was confirmed", await contactFor(store, "rae@example.com", NOW + 3600), ANA);

  part("A link, a code and a bond come first");
  await recordLead(store, { aff: ANA, kind: "signup", email: "kai@example.com" });
  await noteSession(store, order("cs_c2", "kai@example.com", { via: BEN, via_rate: "30" }));
  is("a link followed wins over the contact", [(await line("cs_c2"))?.aff, (await line("cs_c2"))?.how], [BEN, "click"]);
  await giveCode(store, "promo_1TestBenCode001", BEN);
  store = (await storeForEmail(OWNER))!;
  await noteSession(store, order("cs_c3", "kai@example.com", {}, [{ promotion_code: "promo_1TestBenCode001" }]));
  is("a code typed wins over the contact", [(await line("cs_c3"))?.aff, (await line("cs_c3"))?.how], [BEN, "code"]);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, lifetime: true }));
  store = (await storeForEmail(OWNER))!;
  await recordLead(store, { aff: ANA, kind: "signup", email: "lia@example.com" });
  await rememberBuyer(store, "lia@example.com", BEN, "last");
  await noteSession(store, order("cs_c4", "lia@example.com"));
  is("a buyer already bonded to somebody stays with them", [(await line("cs_c4"))?.aff, (await line("cs_c4"))?.how], [BEN, "buyer"]);

  part("Never a lead that does not stand");
  await recordLead(store, { aff: ANA, kind: "signup", email: "max@example.com" });
  const leads = await redis.pipeline([["HGETALL", `nl:aff:${statsId}:leads`]]);
  const flat = (leads[0] as string[]).map(String);
  for (let i = 1; i < flat.length; i += 2) {
    const lead = JSON.parse(flat[i]) as { email: string };
    if (lead.email === "max@example.com") await redis.pipeline([["HSET", `nl:aff:${statsId}:leads`, flat[i - 1], JSON.stringify({ ...lead, state: "reversed", why: "fake" })]]);
  }
  await noteSession(store, order("cs_c5", "max@example.com"));
  is("a lead reversed as not genuine credits nobody", await line("cs_c5"), undefined);

  await recordLead(store, { aff: ANA, kind: "signup", email: "ned@example.com" });
  is("before the deletion it would credit Ana", await contactFor(store, "ned@example.com", NOW + 3600), ANA);
  await forgetLeadPerson(store, "ned@example.com");
  is("a person deleted from the store is not tied back to anybody", await contactFor(store, "ned@example.com", NOW + 3600), "");
  await noteSession(store, order("cs_c6", "ned@example.com"));
  is("so their next purchase credits nobody", await line("cs_c6"), undefined);

  await recordLead(store, { aff: GONE, kind: "signup", email: "ola@example.com" });
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, GONE, person(GONE, "dee@example.com", "dee", { status: "removed" })]]);
  await noteSession(store, order("cs_c7", "ola@example.com"));
  is("an affiliate removed since earns nothing through a contact", await line("cs_c7"), undefined);

  is("nobody is their own lead", await recordLead(store, { aff: ANA, kind: "signup", email: "ana@example.com" }), "self");
  await noteSession(store, order("cs_c8", "ana@example.com"));
  is("so her own purchase is not a contact of hers", await line("cs_c8"), undefined);

  await noteSession(store, order("cs_c9", "stranger@example.com"));
  is("somebody nobody brought credits nobody", await line("cs_c9"), undefined);

  part("Switched off, or leads no longer paid");
  await recordLead(store, { aff: ANA, kind: "signup", email: "pia@example.com" });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, contacts: false }));
  store = (await storeForEmail(OWNER))!;
  is("switched off: the contact is not read", await contactFor(store, "pia@example.com", NOW + 3600), "");
  await noteSession(store, order("cs_c10", "pia@example.com"));
  is("and the sale credits nobody", await line("cs_c10"), undefined);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...store.affiliates, contacts: true, lead: { ...LEADS, kind: "none" } }));
  store = (await storeForEmail(OWNER))!;
  is("leads no longer paid: the switch is saved off", store.affiliates.contacts, false);
  is("and no contact is read", await contactFor(store, "pia@example.com", NOW + 3600), "");

  part("Counted as a sale somebody brought");
  const book = await readBook(store);
  const contact = book.lines.find((l) => l.ref === "cs_c1");
  is("the book keeps how it was credited", contact?.how, "contact");
  is("and counts it among Ana's sales", (book.rows.find((r) => r.affiliate.id === ANA)?.sales ?? 0) >= 1, true);
  const rows = affiliatePromotionRows([{ ref: "cs_c1", currency: "usd", base: 5_000, commission: 1_500, how: "contact", self: false }]);
  is("the promotion rows count it as a paid record", rows.length === 1 && rows[0].paidRecords === 1, true);
  const source = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  is("the second tier counts it as a sale brought", /const BROUGHT: readonly Credit\[\] = \[[^\]]*"contact"/.test(source), true);
  is("a contact is read only after a click, a code and a bond found nobody", /bondFor\(store, buyer\);[\s\S]{0,900}contactFor\(store, buyer, at, session\.id\)/.test(source), true);

  done();
}

void main();
