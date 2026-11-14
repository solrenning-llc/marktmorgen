/**
 * The reminder a buyer asks for themselves (lib/checkout-ask.ts): what lets a
 * creator outside the United States have the abandoned-checkout reminder at
 * all, and what keeps a public form that sends email from being misused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASKS_PER_ADDRESS_HOUR, ASKS_PER_STORE_DAY, ASK_AFTER_SECONDS, askKey, askMember, parseAsk } from "@/lib/checkout-ask";
import { NO_RECOVERY, parseRecovery } from "@/lib/recovery-setting";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ask = { statsId: "stats1", handle: "harbor", productId: "plan", email: "ana@example.com", askedAt: 1_800_000_000, from: "checkout" as const, after: ASK_AFTER_SECONDS };

test("an ask comes back out of the queue as it went in", () => {
  assert.deepEqual(parseAsk(askMember(ask)), ask);
  // One asked for on a product's page, for tomorrow, keeps where and when.
  const onPage = { ...ask, from: "page" as const, after: 86_400 };
  assert.deepEqual(parseAsk(askMember(onPage)), onPage);
});

test("an ask kept before the page could ask reads as it always did", () => {
  assert.equal(askMember(ask), JSON.stringify(["stats1", "harbor", "plan", "ana@example.com", 1_800_000_000]));
  assert.deepEqual(parseAsk(JSON.stringify(["stats1", "harbor", "plan", "ana@example.com", 1_800_000_000])), ask);
  // A wait that is not one of the choices is the hour, never a made-up delay.
  assert.equal(parseAsk(JSON.stringify(["stats1", "harbor", "plan", "ana@example.com", 1_800_000_000, "page", 99_999_999]))?.after, ASK_AFTER_SECONDS);
});

test("anything else in the queue is nothing, not half an ask", () => {
  for (const junk of ["", "not json", "[]", '["a","b","c"]', '["a","b","c","",1]', '["a","b","c","e@x.io","soon"]', 12, null]) {
    assert.equal(parseAsk(junk), null, String(junk));
  }
});

test("each ask has a name of its own, so the same one is never sent twice and two are never confused", () => {
  assert.equal(askKey(ask), askKey({ ...ask, email: " ANA@example.com " }), "the same address however it was typed");
  assert.notEqual(askKey(ask), askKey({ ...ask, productId: "course" }));
  assert.notEqual(askKey(ask), askKey({ ...ask, statsId: "stats2" }));
  assert.notEqual(askKey(ask), askKey({ ...ask, askedAt: ask.askedAt + 1 }));
  assert.match(askKey(ask), /^[0-9a-f]{32}$/);
});

test("the form cannot be turned on somebody's inbox, or run up a bill", () => {
  assert.ok(ASKS_PER_ADDRESS_HOUR >= 1 && ASKS_PER_ADDRESS_HOUR <= 5);
  // One email each at $0.0009: a store's worst day stays under a quarter.
  assert.ok(ASKS_PER_STORE_DAY * 0.0009 < 0.25);
  assert.equal(ASK_AFTER_SECONDS, 3600, "the same hour the other reminder waits");
  const src = code("lib/checkout-ask.ts");
  assert.match(src, /withinEssentialLimit\("remind-ask", ip, ASKS_PER_ADDRESS_HOUR, 3600\)/);
  assert.match(src, /withinEssentialLimit\("remind-store", statsId, ASKS_PER_STORE_DAY, 86_400\)/);
  // A product's ask and a cart's go through the one place those limits are.
  assert.equal((src.match(/return keep\(store, /g) ?? []).length, 2);
});

test("an ask is one email: it puts nobody on the creator's list", () => {
  const src = code("lib/checkout-ask.ts");
  assert.ok(!/upsertContact|importContacts|leadsKey|enroll\(/.test(src), "nothing here touches the list or starts a sequence");
});

test("it is taken off the queue before anything is sent, and put back only after a send that failed", () => {
  const src = code("lib/checkout-ask.ts");
  const at = src.indexOf("export async function sendAsked");
  const body = src.slice(at);
  assert.ok(body.indexOf('["ZREM", QUEUE, member]') < body.indexOf("remindAsked("), "claimed first, so two runs never send the same one");
  assert.match(body, /if \(Number\(taken\) !== 1\) continue;/);
  // A decision (another store, too late, nothing to send) is never put back; a send that failed is, a few times at
  // the most and only inside its six hours (tests/reminders-requeue.test.ts): a reminder hours late is worse than none.
  // Only a failure before the email service was asked is put back (Claude 2 on #3214): its answer cannot tell a refusal
  // from a passing failure, and each ask takes the store's email room again, so "failed" (it was asked) is never.
  assert.match(body, /outcome === "retry" && \(await again\(ask, now\)\)/);
  assert.ok(!/outcome === "failed" && \(await again/.test(body), "a send the email service was asked for is never put back");
  assert.match(body, /store && store\.statsId === ask\.statsId/, "and only for the store it was asked on");
});

test("every kind of yes goes through the one set of limits", () => {
  const src = code("lib/checkout-recovery.ts");
  // Stripe's box, the buyer's own ask, and the Store assistant's box at checkout (lib/assistant-reminder.ts, remindAssisted).
  assert.equal((src.match(/return deliver\(store, \{ kind: "product", product \},/g) ?? []).length, 3, "Stripe's box, the buyer's own ask and the assistant's box");
  assert.equal((src.match(/return deliver\(store, \{ kind: "cart", items \},/g) ?? []).length, 3, "and the same three for a whole cart");
  const deliver = src.slice(src.indexOf("async function deliver("));
  for (const guard of ["offKey(statsId, email)", "onceKey(statsId, email, onceFor)", "parseContact(contact)?.unsub", "paidSince(store, email, ids, how.since)"]) {
    assert.ok(deliver.includes(guard), `the one email is always behind ${guard}`);
  }
  // The words are the store's language's (lib/buyer-words/giving.ts); the English ones say it so.
  assert.match(src, /why: g\.recoverWhyAsked\(store\.name\)/, "and the email says why it came");
  // Asked for on the product's page, it says that, and never that a checkout was left.
  assert.match(src, /ask\.from === "page"[\s\S]{0,80}subject: g\.pageAskSubject\(product\.title\), lead: g\.pageAskLead\(product\.title, store\.name\)/);
  assert.match(code("lib/buyer-words/giving.ts"), /recoverWhyAsked: \(store: string\) => `It reached you because you asked for it on \$\{store\}'s store\.`/);
});

test("Stripe is asked for its own box only where Stripe offers one", () => {
  const src = code("lib/store-checkout.ts");
  assert.match(src, /if \(recovering && store\.recovery\.asks\) applyRecovery\(body\);/);
  assert.match(src, /if \(recovering && !product\.call\) \{\s*body\.set\("cancel_url", `\$\{origin\}\/@\$\{store\.handle\}\/left\?p=\$\{encodeURIComponent\(product\.id\)\}`\);/);
});

test("a store without reminders keeps the way back it always had", () => {
  assert.match(code("lib/store-checkout.ts"), /cancel_url: `\$\{origin\}\/@\$\{store\.handle\}`,/);
});

test("any account may switch reminders on; which half it gets is kept with the setting", () => {
  const route = code("app/api/store/recovery/route.ts");
  assert.match(route, /asks = country\.country === "US";/);
  assert.ok(!/error: "country"/.test(route), "an account outside the United States is no longer refused");
  // A record from before the field existed could only have been a US account's.
  assert.equal(parseRecovery({ enabled: true, address: "1 Main St" }).asks, true);
  assert.equal(parseRecovery({ enabled: true, address: "1 Main St", asks: false }).asks, false);
  assert.equal(NO_RECOVERY.asks, true);
});

test("the form is this site's own, and a robot that fills every field is told it worked", () => {
  const route = code("app/api/store/remind/route.ts");
  assert.match(route, /if \(fromAnotherSite\(request\)\) return new Response\("forbidden", \{ status: 403 \}\);/);
  assert.match(route, /if \(honeypot\.trim\(\)\) return away\("asked"\);/);
  assert.ok(!/status=\$\{[^}]*email/.test(route) && !/email=\$\{/.test(route), "the address typed never goes in an address bar");
});

test("the page asks nothing of somebody who only wants to go back", () => {
  const page = read("app/[handle]/left/page.tsx");
  // The page's words are in the store's language (lib/buyer-words/membership.ts).
  const words = read("lib/buyer-words/membership.ts");
  const back = page.indexOf("w.backTo(product.title)");
  assert.ok(back > 0 && back < page.indexOf('action="/api/store/remind"'), "the way back comes first");
  assert.match(page, /m\.nothingCharged/);
  assert.match(words, /nothingCharged: "Nothing was charged"/);
  assert.match(page, /m\.remindNote\(store\.name\)/);
  assert.match(words, /It does not add you to any list\./);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
});
