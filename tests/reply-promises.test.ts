/**
 * Pages that tell a buyer to reply to their order confirmation to reach the
 * creator (VR, 4 November 2026): each is reached only by someone who paid, and
 * every confirmation such a buyer is sent answers to the creator
 * (replyTo: store.email). Held here so the promise stays true: if one of
 * these emails loses its reply address, or a page that promises it is reached
 * from an email without one, this fails and the words must change.
 *
 * - The page after paying (lib/buyer-words/thanks.ts: notices.unavailable,
 *   notices.refunded, planNote, renewsForReply, renewsUntilReply,
 *   confirmationOnWay, nothingAttachedRest): a checkout's confirmation (lib/purchase-email.ts), a
 *   gift's to whom paid for it (lib/gifts.ts), a purchase for several to whom
 *   paid (lib/group-buy.ts), a booked call's (lib/calls.ts), a package of
 *   calls' (lib/call-packages.ts).
 * - The membership page (lib/buyer-words/membership.ts: notices.unavailable,
 *   manageUnavailable): a membership's checkout confirmation.
 * - A review link that expired (lib/buyer-words/giving.ts, expiredReply): only
 *   sales paid here are reviewed (lib/review-proof.ts), confirmed by a
 *   checkout's, a taken offer's or a PayPal sale's email.
 * Not reached by these words: a gift's email to whom it is for, and a place's
 * in a purchase for several, which carry no reply address.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { thanksWords } from "@/lib/buyer-words/thanks";
import { membershipWords } from "@/lib/buyer-words/membership";
import { givingWords } from "@/lib/buyer-words/giving";

/** Every `sendEmail({ ... })` object in a file, braces balanced. */
function sends(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  let at = text.indexOf("sendEmail({");
  while (at >= 0) {
    let depth = 0;
    let i = at + "sendEmail(".length;
    for (; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(at, i + 1));
    at = text.indexOf("sendEmail({", i);
  }
  return out;
}

/** The emails sent to `to` in `file`: at least one, and each answering to the creator. */
function answersToCreator(file: string, to: string): void {
  const found = sends(file).filter((block) => block.includes(`to: ${to},`));
  assert.ok(found.length > 0, `${file}: no email to ${to}`);
  for (const block of found) assert.ok(block.includes("replyTo: store.email"), `${file}: an email to ${to} has no reply address`);
}

test("every confirmation a paying buyer gets answers to the creator", () => {
  answersToCreator("lib/purchase-email.ts", "letter.to");
  assert.equal(sends("lib/purchase-email.ts").length, sends("lib/purchase-email.ts").filter((b) => b.includes("replyTo: store.email")).length);
  answersToCreator("lib/gifts.ts", "buyer");
  answersToCreator("lib/group-buy.ts", "buyer");
  answersToCreator("lib/calls.ts", "buyerEmail");
  answersToCreator("lib/call-packages.ts", "email");
  answersToCreator("lib/paypal-sales.ts", "paid.email");
});

test("the emails that do not answer to the creator are only to whom a gift or a place is for", () => {
  const gift = sends("lib/gifts.ts").find((block) => block.includes("to: gift.to,"));
  assert.ok(gift && !gift.includes("replyTo"), "a gift's email to whom it is for");
  // Only sales paid here, read from the creator's Stripe account, are reviewed: what was given or brought over is not.
  const proof = readFileSync("lib/review-proof.ts", "utf8");
  assert.ok(proof.includes("onAccount") && !proof.includes("imported-purchases") && !proof.includes("paypal"));
});

test("the pages that promise it say so in the words held above", () => {
  const t = thanksWords("en");
  assert.match(t.notices.unavailable.body, /reply to your order confirmation email/);
  assert.match(t.notices.refunded.body, /reply to the order confirmation/);
  // A payment plan, a renewal the buyer cannot cancel alone, a booked call, and a product with nothing attached.
  assert.match(t.planNote(3, false, "Olive"), /reply to your order confirmation email/);
  assert.match(t.renewsForReply("month", 3, "Olive"), /reply to your order confirmation email/);
  assert.match(t.renewsUntilReply("month", "Olive"), /reply to your order confirmation email/);
  assert.match(t.confirmationOnWay("ana@example.com", "", "Olive"), /reply to the confirmation/);
  assert.match(t.nothingAttachedRest("Olive"), /reply to your order confirmation email/);
  const m = membershipWords("en");
  assert.match(m.manageNotices.unavailable.body, /Reply to your order confirmation email/);
  assert.match(m.manageUnavailable("Olive"), /Reply to your order confirmation email/);
  assert.match(givingWords("en").expiredReply("Olive"), /Reply to the order confirmation/);
});
