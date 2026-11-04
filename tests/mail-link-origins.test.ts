import assert from "node:assert/strict";
import { test } from "node:test";
import { isOwnLink, taggedLink, type MailTag } from "@/lib/mail-links";
import { SITE_URL } from "@/lib/site-url";

const store = { handle: "harbor", domain: null };
const pending = { ...store, domain: { name: "shop.harbor.example", addedAt: "", liveAt: "" } };
const served = { ...pending, domain: { ...pending.domain, liveAt: "2026-11-04T12:00:00.000Z" } };
const readerKey = "a".repeat(24);
const sequence: MailTag = { medium: "sequence", campaign: "s-0123456789abcdef-fedcba9876543210" };
const broadcast: MailTag = { medium: "broadcast", campaign: "b-0123456789abcdef01234567" };

test("a custom domain not yet seen serving the store receives no email or reader tags", () => {
  const href = "https://shop.harbor.example/p/plan?choice=one%20two#details";
  assert.equal(isOwnLink(new URL(href), pending), false);
  for (const tag of [sequence, broadcast]) {
    assert.equal(taggedLink(href, pending, tag, readerKey), href);
  }
});

test("another HTTPS port on the platform is another origin, even on the store's path", () => {
  for (const port of ["8443", "444"]) {
    const href = `${SITE_URL}:${port}/@harbor/p/plan?choice=one%20two#details`;
    assert.equal(isOwnLink(new URL(href), store), false);
    assert.equal(taggedLink(href, store, sequence, readerKey), href);
  }
});

test("a served custom domain does not authorize a different HTTPS port", () => {
  const href = "https://shop.harbor.example:8443/p/plan?choice=one%20two#details";
  assert.equal(isOwnLink(new URL(href), served), false);
  assert.equal(taggedLink(href, served, sequence, readerKey), href);
});

test("served own-store origins retain sequence attribution, including explicit HTTPS port 443", () => {
  for (const href of [
    `${SITE_URL}/@harbor/p/plan?choice=one%20two#details`,
    `${SITE_URL}:443/@harbor/p/plan?choice=one%20two#details`,
    "https://SHOP.HARBOR.EXAMPLE/p/plan?choice=one%20two#details",
    "https://shop.harbor.example:443/p/plan?choice=one%20two#details",
  ]) {
    const before = new URL(href);
    const after = new URL(taggedLink(href, served, sequence, readerKey));
    assert.equal(isOwnLink(before, served), true, href);
    assert.equal(after.origin, before.origin);
    assert.equal(after.pathname, before.pathname);
    assert.equal(after.hash, before.hash);
    assert.equal(after.searchParams.get("choice"), "one two");
    assert.equal(after.searchParams.get("utm_source"), "email");
    assert.equal(after.searchParams.get("utm_medium"), "sequence");
    assert.equal(after.searchParams.get("utm_campaign"), sequence.campaign);
    assert.equal(after.searchParams.get("mk"), readerKey);
  }
});

test("a pending custom domain does not stop attribution on the platform's own store page", () => {
  const href = `${SITE_URL}/@harbor`;
  const after = new URL(taggedLink(href, pending, broadcast, readerKey));
  assert.equal(after.searchParams.get("utm_campaign"), broadcast.campaign);
  assert.equal(after.searchParams.has("mk"), false);
  assert.equal(new URL(taggedLink(href, pending, sequence)).searchParams.has("mk"), false);
});

test("creator tags, other stores, unrelated origins and non-HTTPS destinations remain untouched", () => {
  for (const href of [
    `${SITE_URL}/@harbor?utm_source=own#details`,
    `${SITE_URL}/@harbor?utm_medium=own#details`,
    "https://shop.harbor.example/p/plan?utm_campaign=own#details",
    `${SITE_URL}/@somebody-else`,
    `${SITE_URL}/@harborside`,
    `${SITE_URL}/pricing`,
    "https://shop.harbor.example.somebody-else.example/p/plan",
    "http://shop.harbor.example/p/plan",
    "not an address",
  ]) {
    assert.equal(taggedLink(href, served, sequence, readerKey), href);
  }
});
