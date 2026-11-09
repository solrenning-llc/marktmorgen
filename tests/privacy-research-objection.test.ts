import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SUPPORT_EMAIL } from "@/lib/creator-research";

// The privacy policy's "Research outreach" paragraph tells a creator we wrote
// to first how to object (GDPR art. 21). No code sends that research message
// and nothing reads a reply for the word "stop" or keeps a do-not-contact list
// from it, so the only way that works today is the support address the policy
// already prints, which lib/inbound-mail.ts passes on to the inbox that is read.
const page = readFileSync(join(process.cwd(), "app/privacy/page.tsx"), "utf8");

function paragraph(title: string): string {
  const start = page.indexOf(`<strong className="text-black">${title}.</strong>`);
  assert.ok(start > 0, `the "${title}" paragraph is in the privacy policy`);
  const end = page.indexOf("</p>", start);
  assert.ok(end > start);
  return page.slice(start, end).replace(/\s+/g, " ");
}

test("research outreach: objecting does not depend on a reply keyword nothing reads", () => {
  const text = paragraph("Research outreach");
  assert.doesNotMatch(text, /stop/i, "no reply keyword is promised: no code handles a reply that says stop");
  assert.doesNotMatch(text, /object[^.]*\breplying\b/i, "objecting is not promised by replying to a message no code sends");
});

test("research outreach: objecting names the support address the policy already prints", () => {
  const text = paragraph("Research outreach");
  // Rule 23: was /You can object at any time by emailing us at/. Since the do-not-contact list exists
  // (lib/research-do-not-contact.ts, owner's decision 13), the policy names its page first and the
  // support address beside it; the address is still a way that works.
  assert.match(text, /You can object at any time on our\b.*do-not-contact page.*or by emailing us at/);
  assert.ok(text.includes(`href="mailto:${SUPPORT_EMAIL}"`), "the address is a mail link");
  assert.ok(text.includes(`> ${SUPPORT_EMAIL} </a>`), "the address is shown in full");
  assert.match(text, /we will not contact you again\./);
  // The same address the rest of the policy gives for every privacy request.
  assert.ok(page.split(`mailto:${SUPPORT_EMAIL}`).length > 3);
});
