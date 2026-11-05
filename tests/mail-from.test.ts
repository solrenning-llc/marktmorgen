/**
 * The address a creator's email goes out from (lib/mail-from.ts): their own,
 * on a domain set apart from the one login links and receipts come from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atSiteAddress, creatorAddress, creatorDomain, domainOf } from "@/lib/mail-from";
import { fromLine } from "@/lib/mail";
import { fromCreator, fromStore } from "@/lib/purchase-email";
import { NIMBUS_FROM, sendBatch } from "@/lib/email";
import type { Store } from "@/lib/store";

const SITE = "Marktmorgen <hello@marktmorgen.com>";
const store = { handle: "harborkitchen", name: "Harbor Kitchen", email: "ana@example.com", mail: { fromName: "Ana at Harbor Kitchen" } } as unknown as Store;

function withDomain<T>(value: string | undefined, run: () => T): T {
  const before = process.env.MARKETING_FROM_DOMAIN;
  if (value === undefined) delete process.env.MARKETING_FROM_DOMAIN;
  else process.env.MARKETING_FROM_DOMAIN = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.MARKETING_FROM_DOMAIN;
    else process.env.MARKETING_FROM_DOMAIN = before;
  }
}

test("the domain of a From line is read whether or not a name is in front", () => {
  assert.equal(domainOf(SITE), "marktmorgen.com");
  assert.equal(domainOf("hello@Marktmorgen.com"), "marktmorgen.com");
  assert.equal(domainOf("nobody"), "");
});

test("with a domain set apart, each store writes from its own address on it", () => {
  assert.equal(creatorAddress("harborkitchen", SITE, "mail.marktmorgen.com"), "harborkitchen@mail.marktmorgen.com");
  assert.equal(creatorAddress("ana.b_c-d", SITE, " Mail.Marktmorgen.com. "), "ana.b_c-d@mail.marktmorgen.com");
  // Two full stops in a row are a handle and not an address.
  assert.equal(creatorAddress("a..b", SITE, "mail.marktmorgen.com"), "a.b@mail.marktmorgen.com");
});

test("no setting, or one that is not a domain, changes nothing", () => {
  for (const raw of [undefined, "", "   ", "mail", "mail marktmorgen.com", "hello@mail.marktmorgen.com", "https://mail.marktmorgen.com", "-mail.marktmorgen.com", "mail..marktmorgen.com"]) {
    assert.equal(creatorDomain(SITE, raw), null, String(raw));
    assert.equal(creatorAddress("harborkitchen", SITE, raw), null, String(raw));
  }
});

test("the domain the site's own email comes from is never the creators'", () => {
  // A store called "hello" would otherwise write from the address login links come from.
  assert.equal(creatorDomain(SITE, "marktmorgen.com"), null);
  assert.equal(creatorAddress("hello", SITE, "marktmorgen.com"), null);
  assert.equal(creatorAddress("hello", SITE, "mail.marktmorgen.com"), "hello@mail.marktmorgen.com");
});

test("an email Resend will not take from the creators' domain goes from the site's own address, under the same name", () => {
  assert.equal(atSiteAddress('"Ana at Harbor Kitchen" <harborkitchen@mail.marktmorgen.com>', SITE), '"Ana at Harbor Kitchen" <hello@marktmorgen.com>');
  assert.equal(atSiteAddress("harborkitchen@mail.marktmorgen.com", SITE), "hello@marktmorgen.com");
  assert.equal(atSiteAddress('"Lee via Harbor Kitchen" <harborkitchen@mail.marktmorgen.com>', "hello@marktmorgen.com"), '"Lee via Harbor Kitchen" <hello@marktmorgen.com>');
});

test("a handle that cannot be the first half of an address falls back", () => {
  for (const handle of ["", " ", "a b", "a@b", "<a>", ".a", "a.", "a\r\nBcc: x"]) {
    assert.equal(creatorAddress(handle, SITE, "mail.marktmorgen.com"), null, JSON.stringify(handle));
  }
});

test("a creator's list email is from their own name at their own address", () => {
  const site = domainOf(NIMBUS_FROM);
  withDomain("creators.example.org", () => {
    assert.equal(fromLine(store), '"Ana at Harbor Kitchen" <harborkitchen@creators.example.org>');
    assert.equal(fromCreator(store), '"Harbor Kitchen" <harborkitchen@creators.example.org>');
    // A receipt stays on the site's own address whatever is set.
    assert.equal(domainOf(fromStore(store)), site);
  });
  withDomain(undefined, () => {
    assert.equal(domainOf(fromLine(store)), site);
    assert.equal(domainOf(fromCreator(store)), site);
  });
});

test("a list email Resend will not take from the creators' domain goes out from the site's own address", async () => {
  const keyBefore = process.env.RESEND_API_KEY;
  const fetchBefore = globalThis.fetch;
  process.env.RESEND_API_KEY = "re_test_site_key_a_stand_in";
  const asked: { from: string[]; key: string | null; status: number }[] = [];
  let refuse = true;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const from = (JSON.parse(String(init?.body)) as { from: string }[]).map((m) => m.from);
    const status = refuse && from.some((line) => /@creators\.example\.org/.test(line)) ? 403 : 200;
    asked.push({ from, key: new Headers(init?.headers).get("Idempotency-Key"), status });
    return new Response(JSON.stringify({ data: from.map((_, i) => ({ id: `synthetic_${i}` })) }), { status });
  }) as typeof fetch;
  const domainBefore = process.env.MARKETING_FROM_DOMAIN;
  process.env.MARKETING_FROM_DOMAIN = "creators.example.org";
  try {
    {
      const message = { from: fromLine(store), to: "lee@example.org", subject: "Hello", text: "Hi", html: "<p>Hi</p>" };
      assert.equal(await sendBatch([message], "batch-1", { by: "company" }), "sent");
      assert.deepEqual(asked, [
        { from: ['"Ana at Harbor Kitchen" <harborkitchen@creators.example.org>'], key: "batch-1", status: 403 },
        { from: [`"Ana at Harbor Kitchen" <${NIMBUS_FROM.match(/<([^>]+)>/)?.[1] ?? NIMBUS_FROM}>`], key: "batch-1:site", status: 200 },
      ]);
      // And when Resend takes the domain, nothing is sent twice or rewritten.
      refuse = false;
      asked.length = 0;
      assert.equal(await sendBatch([message], "batch-2", { by: "company" }), "sent");
      assert.deepEqual(asked.map((one) => [one.from[0], one.key]), [['"Ana at Harbor Kitchen" <harborkitchen@creators.example.org>', "batch-2"]]);
    }
  } finally {
    globalThis.fetch = fetchBefore;
    if (domainBefore === undefined) delete process.env.MARKETING_FROM_DOMAIN;
    else process.env.MARKETING_FROM_DOMAIN = domainBefore;
    if (keyBefore === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = keyBefore;
  }
});

test("every email that asks for a sale or goes to a list is sent from the creator's address", () => {
  // Each of these builds its From line with fromLine or fromCreator; none may
  // go back to the address receipts come from.
  const promotional = ["lib/mail.ts", "lib/waitlist.ts", "lib/review-requests.ts", "lib/winback-send.ts", "lib/community-mail.ts", "lib/checkout-recovery.ts", "app/api/store/mail/route.ts"];
  for (const file of promotional) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    assert.match(source, /from: (fromLine|fromCreator)\(/, file);
    assert.doesNotMatch(source, /from: fromStore\(/, file);
  }
});

test("Amazon is told about both domains, and may send from both", () => {
  const stack = readFileSync(join(process.cwd(), "infra/amazon-ses.yml"), "utf8");
  assert.match(stack, /identity\/\$\{DomainName\}/);
  assert.match(stack, /identity\/\$\{CreatorsDomainName\}/);
  assert.match(stack, /EmailIdentity: !Ref CreatorsDomainName/);
  // Each names the address its bounces come back to as its own.
  assert.match(stack, /MailFromDomain: !Sub send\.\$\{DomainName\}/);
  assert.match(stack, /MailFromDomain: !Sub send\.\$\{CreatorsDomainName\}/);
});
