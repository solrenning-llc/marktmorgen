/**
 * A partner's share of the product itself.
 *
 * What Hotmart files under its own "sales management and strategy" section and
 * calls Coprodução: somebody who helped make a product, or lent their audience
 * to its launch, takes a percentage of every sale of it — not only the sales
 * they personally referred. It is the difference between a partner and an
 * affiliate, and it is how a creator with no audience borrows one.
 *
 * Verified on Hotmart's own help centre on 4 October 2026, including the line
 * that decides this: "O coprodutor precisa ter uma conta Hotmart ativa para
 * receber um convite." Theirs only works between people already inside
 * Hotmart. Ours needs the partner to have no account anywhere — the creator
 * invites an email address, and the money is paid to a PayPal address. Stan
 * publishes only Affiliate Share, on its $99 plan; Kajabi publishes affiliates
 * from Growth at $199. Neither publishes anything that splits revenue with a
 * partner at all.
 *
 * And ours never divides a payment in flight, because the payment never
 * touches us: the share is recorded against each sale and paid by the creator
 * out of their own PayPal, in the batch they already send their affiliates.
 *
 * These hold the part a creator cannot be allowed to get wrong. A product has
 * one price, and everything promised on it — every partner, plus the affiliate
 * commission that rides on the same sale — comes out of that one price. Set
 * three shares carelessly and the product is sold at a loss, and the creator
 * finds out on an invoice. So it is capped, and the screen says what they keep
 * while they choose.
 */
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AffiliateCommissionHistory } from "@/components/affiliate-commission-history";
import { affiliateCreditGroups, type AffiliateCommissionLine } from "@/lib/affiliate-commission-view";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import {
  MAX_COMMITTED_SHARE,
  MAX_PARTNERS_PER_PRODUCT,
  MAX_PARTNER_SHARE,
  MIN_PARTNER_SHARE,
  creatorKeeps,
  parsePartnerShare,
  shareCents,
  shareOn,
  shareProblem,
} from "@/lib/partner-share";

const A = "prodaaaaaa";
const B = "prodbbbbbb";

// ---- what a share is ----------------------------------------------------

test("a share is a whole percentage of named products, and nothing else", () => {
  assert.deepEqual(parsePartnerShare({ percent: 30, products: [A, B] }), { percent: 30, products: [A, B] });
  // A form sends strings.
  assert.deepEqual(parsePartnerShare({ percent: "25", products: [A] }), { percent: 25, products: [A] });
  // Duplicates are one product.
  assert.deepEqual(parsePartnerShare({ percent: 10, products: [A, A] }), { percent: 10, products: [A] });
});

test("a share of everything is refused, because nobody agreed to the next product", () => {
  // A partner on "all products" would silently start earning on something
  // made months later that they had no part in. The creator names them.
  assert.equal(parsePartnerShare({ percent: 30, products: [] }), null);
  assert.equal(parsePartnerShare({ percent: 30 }), null);
  assert.equal(parsePartnerShare({ percent: 30, products: "all" }), null);
});

test("a share outside the range is nothing, not a clamped something", () => {
  for (const percent of [0, -5, MAX_PARTNER_SHARE + 1, 100, 1.5, "lots", null, NaN]) {
    assert.equal(parsePartnerShare({ percent, products: [A] }), null, `${String(percent)} is not a share`);
  }
  assert.ok(parsePartnerShare({ percent: MIN_PARTNER_SHARE, products: [A] }));
  assert.ok(parsePartnerShare({ percent: MAX_PARTNER_SHARE, products: [A] }));
});

test("the ceiling leaves the creator something, which is the point of having one", () => {
  // A product whose whole price is promised away earns nothing and still costs
  // the card fee, the delivery and the support: that is a product sold at a
  // loss, set up in two clicks.
  assert.ok(MAX_PARTNER_SHARE < 100, "a 100% partner means the creator sells at a loss");
  assert.ok(MAX_COMMITTED_SHARE < 100, "and so does 100% committed across everybody");
});

test("it applies to the products named and no others", () => {
  const share = parsePartnerShare({ percent: 40, products: [A] });
  assert.equal(shareOn(share, A), 40);
  assert.equal(shareOn(share, B), 0, "a product they have no part in earns them nothing");
  assert.equal(shareOn(share, ""), 0);
  assert.equal(shareOn(null, A), 0, "an ordinary affiliate holds no standing share");
});

test("the money is whole cents, rounded down, never invented", () => {
  assert.equal(shareCents(10_000, 30), 3_000);
  assert.equal(shareCents(999, 33), 329, "a third of 9.99 is 3.2967, and the partner gets 3.29");
  assert.equal(shareCents(0, 50), 0);
  assert.equal(shareCents(-100, 50), 0);
  assert.equal(shareCents(10_000, 0), 0);
});

// ---- the cap, which is the creator's protection -------------------------

test("one partner inside the cap is allowed", () => {
  assert.equal(
    shareProblem({ percent: 40, products: [A], others: {}, affiliatePercent: { [A]: 20 } }),
    null,
    "40 to the partner and 20 to an affiliate is 60: the creator keeps 40",
  );
});

test("two partners and a commission that together pass the cap are refused", () => {
  // 50 + 30 + 20 = 100. The creator would be paying out the whole price and
  // Stripe's fee on top.
  assert.equal(
    shareProblem({ percent: 30, products: [A], others: { [A]: [50] }, affiliatePercent: { [A]: 20 } }),
    "committed",
  );
});

test("the affiliate commission counts, because it rides on the same sale", () => {
  // Without counting it, two partners at 45 each would look fine and the sale
  // would owe 110% once an affiliate brought the buyer.
  assert.equal(shareProblem({ percent: 45, products: [A], others: { [A]: [45] }, affiliatePercent: {} }), null);
  assert.equal(
    shareProblem({ percent: 45, products: [A], others: { [A]: [45] }, affiliatePercent: { [A]: 20 } }),
    "committed",
    "the same two partners become impossible once the product pays a commission",
  );
});

test("a product takes the cap product by product, not on average", () => {
  // Fine on one, impossible on the other: the whole share is refused rather
  // than quietly applied to the half that fits.
  assert.equal(
    shareProblem({ percent: 40, products: [A, B], others: { [B]: [60] }, affiliatePercent: {} }),
    "committed",
  );
});

test("a product cannot hold more partners than it can be divided between", () => {
  const many = Array.from({ length: MAX_PARTNERS_PER_PRODUCT }, () => 1);
  assert.equal(shareProblem({ percent: 1, products: [A], others: { [A]: many }, affiliatePercent: {} }), "crowded");
});

test("the cap is checked before the range, so a bad number says it is a bad number", () => {
  assert.equal(shareProblem({ percent: 0, products: [A], others: {}, affiliatePercent: {} }), "percent");
  assert.equal(shareProblem({ percent: 30, products: [], others: {}, affiliatePercent: {} }), "products");
});

// ---- what the creator is left with -------------------------------------

test("what the creator keeps counts everything promised, and never goes below zero", () => {
  assert.equal(creatorKeeps({ partners: [40], affiliatePercent: 20 }), 40);
  assert.equal(creatorKeeps({ partners: [30, 30], affiliatePercent: 20 }), 20);
  assert.equal(creatorKeeps({ partners: [], affiliatePercent: 0 }), 100);
  assert.equal(creatorKeeps({ partners: [80, 80], affiliatePercent: 20 }), 0, "never a negative share");
});

test("the creator sees what they keep while they choose, not on an invoice", () => {
  const studio = readFileSync(join(process.cwd(), "components/affiliate-studio.tsx"), "utf8");
  assert.match(studio, /creatorKeeps\(/, "the figure has to be worked out on the screen");
  assert.match(studio, /you keep \$\{keeps\}%/, "and shown against each product as it is ticked");
  assert.match(studio, /keeps < 25 \?/, "and marked when what is left stops being a margin");
  assert.match(
    studio,
    /Stripe's fee comes out of your part/,
    "a creator reading 'you keep 20%' has to know the card fee is inside that 20, not beside it",
  );
});

// ---- never in flight, which is the whole architecture -------------------

test("no part of this divides a payment: the share is recorded and paid later", () => {
  const src = readFileSync(join(process.cwd(), "lib/partner-share.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const word of ["transfer", "application_fee", "destination", "stripe", "payout", "redis"]) {
    assert.doesNotMatch(
      code,
      new RegExp(word, "i"),
      `lib/partner-share.ts must not reach for ${word}: it decides what a share is, and nothing else. ` +
        "Dividing a charge in flight would make us the intermediary this product exists to not be.",
    );
  }
});

test("a partner is paid through the rails the affiliates already use", () => {
  // The reason a partner's share reads as one more Referral credited
  // "partner": the payouts, the PayPal batches, the payday email, the
  // spreadsheet and the partner's own page then all work unchanged.
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  assert.match(aff, /export type Credit = "click" \| "code" \| "buyer" \| "partner"/);
  assert.match(aff, /how: "partner" as const/, "a share has to enter the book as a line like any other");
  assert.match(aff, /sharesKey\(statsId\)/, "and be read back into it");
});

test("a partner never earns on their own purchase", () => {
  // A 50% partner buying their own product at 50% off is not a sale.
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const at = aff.indexOf("export async function notePartners");
  assert.ok(at > 0, "notePartners should exist");
  const body = aff.slice(at, aff.indexOf("async function isSelf"));
  assert.match(body, /self: Boolean\(buyer\) && normaliseEmail\(partner\.email\) === buyer/);
});

test("a share is written for every sale, not only the referred ones", () => {
  // This is the difference from a commission, and it is the one thing that
  // had to change in the sweep: it used to skip any order nobody referred.
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const at = aff.indexOf("export async function noteSession");
  const body = aff.slice(at, aff.indexOf("export async function noteCharge"));
  const partners = body.indexOf("notePartners");
  const bails = body.indexOf("if (!found) return;");
  assert.ok(partners > 0 && bails > 0, "both should be in noteSession");
  assert.ok(partners < bails, "the partner lines must be written before any path that gives up on finding an affiliate");

  const sweep = readFileSync(join(process.cwd(), "lib/checkout-sweep.ts"), "utf8");
  assert.match(sweep, /row\.metadata\?\.via \|\| code \|\| partners\.length/, "and the sweep has to stop skipping unreferred sales");
});

test("a sale already made keeps the share it was made at", () => {
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const at = aff.indexOf("export async function notePartners");
  const body = aff.slice(at, aff.indexOf("async function isSelf"));
  assert.match(body, /percent: shareOn\(partner\.share, sale\.product, sale\.at\)/, "the percentage is frozen onto the line, read at the sale's own time");
  assert.match(
    aff,
    /Shares already earned are untouched by a change here/,
    "and setPartnerShare has to say so, because a creator lowering a share should not reach back into last month",
  );
});

// ---- the invitation -----------------------------------------------------

test("the partner needs no account anywhere, which is where Hotmart stops", () => {
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const at = aff.indexOf("export async function invitePartner");
  assert.ok(at > 0, "the creator has to be able to invite somebody from outside");
  const body = aff.slice(at, aff.indexOf("export async function acceptPartnership"));
  // The words are in the store's language (lib/buyer-words/affiliates.ts).
  assert.match(body, /a\.partnerPays\(store\.name\)/, "and the email has to say so");
  assert.match(body, /a\.partnerOffer\(store\.name, share\.percent\)/, "the email states the share");
  const words = AFFILIATES_WORDS.en;
  assert.match(words.partnerPays("Harbor Kitchen"), /you need no account with us/, "and the email has to say so");
  assert.match(words.partnerOffer("Harbor Kitchen", 30), /30% of every sale of/, "the email states the share");
  assert.match(words.partnerPays("Harbor Kitchen"), /pays you directly, from their own account/, "and who pays, because it is not us");
});

test("nothing is written down until the invitation is opened", () => {
  // An address typed wrong should leave no half-made partner in the programme.
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const at = aff.indexOf("export async function invitePartner");
  const body = aff.slice(at, aff.indexOf("export async function acceptPartnership"));
  assert.doesNotMatch(body, /writeAffiliate/, "the record is made when they open the link, not when it is sent");
  // The reason belongs in the comment over it, which is above `at`.
  assert.match(
    aff.slice(Math.max(0, at - 1_200), at),
    /Nothing is written down until they open the link/,
    "and the reason is written beside it",
  );
});

test("an invitation arrives already approved, with the share the email stated", () => {
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const at = aff.indexOf("export async function openAffiliateLink");
  const body = aff.slice(at, aff.indexOf("export function buyersJoin"));
  assert.match(body, /grant\.k === 1/, "an invitation has to be told apart from an application");
  assert.match(body, /status: invited \? "approved" : "pending"/, "a partner the creator asked for does not wait in a queue");
  assert.match(body, /share: invited \? grant\.p \?\? null : null/, "and the share travels with it");
});

test("an invitation cannot be used to attach a share nobody checked", () => {
  // The cap is checked at the route, before the email goes out, exactly as it
  // is for somebody already in the programme.
  const route = readFileSync(join(process.cwd(), "app/api/store/affiliates/route.ts"), "utf8");
  const at = route.indexOf('if (action === "invite")');
  assert.ok(at > 0, "the invite action should exist");
  const body = route.slice(at, route.indexOf('if (action === "share")'));
  // The same cap as a share set for somebody already in, through one helper
  // (lib/affiliates.ts sharePromiseProblem, which calls shareProblem).
  assert.match(body, /sharePromiseProblem\(store, null, share, now\)/, "the invite path has to run the same cap");
  assert.ok(body.indexOf("sharePromiseProblem(") < body.indexOf("invitePartner("), "and run it before sending anything");
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const helper = aff.slice(aff.indexOf("export async function sharePromiseProblem"));
  assert.match(helper.slice(0, helper.indexOf("\n}\n")), /return shareProblem\(/, "and that helper is the cap itself");
});

// ---- a moat switched off is not a moat ---------------------------------

test("the creator can see the credit route on each commission record", () => {
  const kinds = ["click", "code", "buyer", "partner"] as const;
  const lines: AffiliateCommissionLine[] = kinds.map((how,i) => ({ref:String(i),at:1700000000,title:"Course",aff:"a",base:1000,refunded:0,rate:10,commission:100,status:"earned",how,currency:"usd"}));
  const html = renderToStaticMarkup(createElement(AffiliateCommissionHistory,{lines,total:lines.length,who:new Map(),refundsChecked:true,invoicesChecked:true}));
  for (const words of ["Their link", "Their code", "A buyer who was already theirs", "Partner share"]) {
    assert.ok(html.includes("10% · " + words), `each record must name its credit route: ${words}`);
  }
  const page = readFileSync(join(process.cwd(), "app/studio/affiliates/page.tsx"), "utf8");
  assert.match(page, /how: line\.how/, "the page still passes the recorded route");
});

test("displayed positive commission records are counted without mixing currencies or inventing purchases", () => {
  const a: AffiliateCommissionLine = {ref:"a",at:1700000000,title:"Course",aff:"a",base:1000,refunded:0,rate:10,commission:100,status:"earned",how:"click",currency:"usd"};
  const lines: AffiliateCommissionLine[] = [a,{...a,ref:"b",commission:150},{...a,ref:"c",currency:"eur",commission:200},{...a,ref:"d",how:"code",commission:0},{...a,ref:"e",how:"bonus",commission:300},{...a,ref:"f",how:"tier2",commission:40}];
  const groups = affiliateCreditGroups(lines);
  assert.deepEqual(groups.find(g=>g.how==="click"&&g.currency==="usd"),{how:"click",currency:"usd",records:2,commission:250});
  assert.deepEqual(groups.find(g=>g.how==="click"&&g.currency==="eur"),{how:"click",currency:"eur",records:1,commission:200});
  assert.equal(groups.some(g=>g.how==="code"),false,"zero-commission routes have no summary group");
  assert.equal(groups.find(g=>g.how==="bonus")?.records,1);
  assert.equal(groups.find(g=>g.how==="tier2")?.records,1);
  const html=renderToStaticMarkup(createElement(AffiliateCommissionHistory,{lines,total:lines.length,who:new Map(),refundsChecked:true,invoicesChecked:true}));
  assert.ok(html.includes("2 commission records")&&html.includes("(USD)")&&html.includes("(EUR)"));
  assert.ok(html.includes("not additional purchases"));
});

test("no number is invented for a store that has the bond switched off", () => {
  // The tempting thing here was a counterfactual: "you would have earned X."
  // It cannot be honest. With the bond off, nothing is written down, so there
  // is nothing to count — and recording buyers against affiliates anyway, for
  // a creator who did not ask for it, would be collecting what we are not
  // using. The switch says what it does; the figures stay real.
  const bond = readFileSync(join(process.cwd(), "lib/affiliate-bond.ts"), "utf8");
  assert.match(bond, /if \(!bondsBuyers\(store\)/, "nothing is remembered unless the creator asked for it");
  const studio = readFileSync(join(process.cwd(), "components/affiliate-studio.tsx"), "utf8");
  assert.doesNotMatch(studio, /would have earned|could have earned|missed out/i, "no invented counterfactual");
});
