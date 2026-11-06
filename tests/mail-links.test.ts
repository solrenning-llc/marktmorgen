/**
 * The tag an email's links carry, and the sales counted from it
 * (lib/mail-links.ts, lib/mail-revenue.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { broadcastCampaign, flowCampaignPrefix, stepCampaign, taggedLink } from "@/lib/mail-links";
import { broadcastMoney, flowMoney, moneyByCampaign } from "@/lib/mail-revenue";
import { bodyHtml } from "@/lib/mail";
import { cameFrom } from "@/lib/came-from";
import { SITE_URL } from "@/lib/site-url";

const store = { handle: "harbor", domain: null };
const tag = { medium: "broadcast" as const, campaign: broadcastCampaign("a".repeat(24)) };
const home = `${SITE_URL}/@harbor`;

test("a link to the creator's own store is tagged with the email it came from", () => {
  const url = new URL(taggedLink(`${home}/p/plan`, store, tag));
  assert.equal(url.pathname, "/@harbor/p/plan");
  assert.equal(url.searchParams.get("utm_source"), "email");
  assert.equal(url.searchParams.get("utm_medium"), "broadcast");
  assert.equal(url.searchParams.get("utm_campaign"), tag.campaign);
});

test("the store's own domain counts as the store", () => {
  const own = { handle: "harbor", domain: { name: "shop.harbor.example", addedAt: "", liveAt: "x" } };
  assert.match(taggedLink("https://shop.harbor.example/p/plan", own, tag), /utm_campaign=/);
});

test("somebody else's address is left exactly as typed", () => {
  for (const href of ["https://example.com/a?b=1", `${SITE_URL}/@somebody-else`, `${SITE_URL}/@harborside`, `${SITE_URL}/pricing`, "https://youtube.com/watch?v=1"]) {
    assert.equal(taggedLink(href, store, tag), href, href);
  }
});

test("a link the creator tagged themselves is theirs to measure", () => {
  const href = `${home}?utm_campaign=my-own`;
  assert.equal(taggedLink(href, store, tag), href);
});

test("what cannot be read as an address comes back unchanged", () => {
  assert.equal(taggedLink("not an address", store, tag), "not an address");
});

test("the tag survives the cleaning the checkout gives it, whole", () => {
  // lib/came-from.ts keeps forty characters of a campaign. A tag cut short
  // there would be a sale counted for no email at all.
  for (const campaign of [broadcastCampaign("0123456789abcdef01234567"), stepCampaign("0123456789abcdef", "fedcba9876543210")]) {
    const landed = taggedLink(home, store, { medium: "sequence", campaign });
    const read = cameFrom(landed, new URL(SITE_URL).hostname);
    assert.equal(read.campaign, campaign);
    assert.equal(read.source, "email");
  }
});

test("the reader sees the address as written; only where it goes is tagged", () => {
  const html = bodyHtml(`Here it is: ${home}/p/plan`, (href) => taggedLink(href, store, tag));
  assert.match(html, new RegExp(`>${home.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/p/plan</a>`), "the words are the creator's");
  assert.match(html, /href="[^"]*utm_campaign=b-a{24}"/, "the destination carries the tag");
});

test("a full stop after an address ends the sentence, not the link", () => {
  // It used to be part of the link, which then opened a page that is not there.
  const html = bodyHtml("Read it at https://example.com/plan. Then write back.");
  assert.match(html, /<a href="https:\/\/example\.com\/plan"[^>]*>https:\/\/example\.com\/plan<\/a>\./);
});

test("sales are added up by email, from email only, in the store's currency; another currency's are counted apart, never added", () => {
  const c1 = broadcastCampaign("1".repeat(24));
  const by = moneyByCampaign(
    [
      { source: "email", campaign: c1, cents: 2700, currency: "usd" },
      { source: "email", campaign: c1, cents: 3900, currency: "usd" },
      { source: "email", campaign: c1, cents: 5000, currency: "eur" },
      { source: "instagram", campaign: c1, cents: 9900, currency: "usd" },
      { source: "email", campaign: "", cents: 100, currency: "usd" },
    ],
    "usd",
  );
  // The euro sale is from before the store changed its currency (22 [E5], unit 2d).
  assert.deepEqual(by, { [c1]: { sales: 2, cents: 6600, elsewhere: 1 } });
  assert.deepEqual(broadcastMoney({ by, partial: false }, "1".repeat(24)), { sales: 2, cents: 6600, elsewhere: 1 });
  // An email whose only sale was in another currency still shows it, as a count.
  const c3 = broadcastCampaign("3".repeat(24));
  const only = moneyByCampaign([{ source: "email", campaign: c3, cents: 5000, currency: "eur" }], "usd");
  assert.deepEqual(broadcastMoney({ by: only, partial: false }, "3".repeat(24)), { sales: 0, cents: 0, elsewhere: 1 });
  assert.equal(broadcastMoney({ by, partial: false }, "2".repeat(24)), null);
  assert.equal(broadcastMoney(null, "1".repeat(24)), null);
});

test("a sequence's figure is every one of its emails together, and nobody else's", () => {
  const flow = "f".repeat(16);
  const by = {
    [stepCampaign(flow, "1".repeat(16))]: { sales: 1, cents: 2700 },
    [stepCampaign(flow, "2".repeat(16))]: { sales: 2, cents: 7800 },
    [stepCampaign("e".repeat(16), "1".repeat(16))]: { sales: 5, cents: 99900 },
  };
  assert.deepEqual(flowMoney({ by, partial: false }, flow), { sales: 3, cents: 10500 });
  // A sequence whose only sale was in another currency still shows it, as a count (22 [E5], unit 2d).
  assert.deepEqual(flowMoney({ by: { [stepCampaign(flow, "3".repeat(16))]: { sales: 0, cents: 0, elsewhere: 2 } }, partial: false }, flow), { sales: 0, cents: 0, elsewhere: 2 });
  assert.equal(flowMoney({ by, partial: false }, "d".repeat(16)), null);
  assert.ok(stepCampaign(flow, "1".repeat(16)).startsWith(flowCampaignPrefix(flow)));
});

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("both kinds of email are sent with their tag", () => {
  // The email's own tag, or one subject line's when two are being tried
  // (lib/mail-test.ts); what actually goes out is checked in mail-test.test.ts.
  const broadcasts = read("lib/broadcasts.ts");
  assert.match(broadcasts, /const campaign = part === "rest" \? broadcastCampaign\(id\) : variantCampaign\(id, part\);/);
  assert.match(broadcasts, /b\.tagged \? \{ medium: "broadcast", campaign \} : undefined/);
  assert.match(read("lib/flows.ts"), /\{ medium: "sequence", campaign: stepCampaign\(flow\.id, step\.id\) \}/);
});

test("an email made before links were tagged is never said to have sold nothing", () => {
  const src = read("components/email-studio.tsx");
  assert.match(src, /b\.status === "sent" && b\.tagged \?/, "the figure is shown only where it could have been counted");
  assert.match(read("lib/broadcasts.ts"), /tagged: value\.tagged === true/, "and an old record reads as not tagged");
});

test("the tag is one per email, with nothing of the reader in it", () => {
  const src = read("lib/mail-links.ts").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/email\b.*searchParams|token|recipient/i.test(src), "nothing about who the email was sent to goes on a link");
});
