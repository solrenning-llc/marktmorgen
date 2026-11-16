/**
 * 405 [HX1] unit 2: the confirm and leave links of an address outside the
 * team. Synthetic stores and addresses only; nothing stored or sent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { linkFits, linkHash, linkRecord, newLinkToken } from "@/lib/report-guests-links";
import { INVITE_DAYS, type Guest } from "@/lib/report-guests-rules";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12);
const invited: Guest = { address: "partner@example.test", state: "invited", invitedAt: NOW - DAY };
const confirmed: Guest = { ...invited, state: "confirmed" };

test("a token is random, opaque and kept only as its hash", () => {
  const a = newLinkToken();
  const b = newLinkToken();
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(linkHash(a.token), a.hash);
  assert.notEqual(a.hash, a.token);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  // Nothing of the store or the address can be in it: it is made from nothing but randomness.
  assert.equal(newLinkToken.length, 0);
  for (const bad of ["", "short", `${a.token}x`, a.token.replace(/.$/, "="), 42, null, undefined]) assert.equal(linkHash(bad), null, `refused: ${String(bad)}`);
});

test("the record holds one store, one address, one invitation and one kind", () => {
  const record = linkRecord("confirm", "store-a", invited);
  assert.deepEqual(record, { kind: "confirm", store: "store-a", address: "partner@example.test", invitedAt: invited.invitedAt, expiresAt: invited.invitedAt + INVITE_DAYS * DAY });
  assert.equal(linkRecord("leave", "store-a", invited).expiresAt, null, "a leave link works for as long as the address is on the list");
});

test("a confirm link confirms its own invitation, once, until it lapses", () => {
  const record = linkRecord("confirm", "store-a", invited);
  assert.equal(linkFits(record, { kind: "confirm", store: "store-a" }, invited, NOW), "ok");
  assert.equal(linkFits(record, { kind: "confirm", store: "store-a" }, confirmed, NOW), "done", "pressed again: already confirmed, nothing changes");
  assert.equal(linkFits(record, { kind: "confirm", store: "store-a" }, invited, record.expiresAt!), "expired");
});

test("a link never works for another store, another kind, another address or a newer invitation", () => {
  const record = linkRecord("confirm", "store-a", invited);
  assert.equal(linkFits(record, { kind: "confirm", store: "store-b" }, invited, NOW), "no");
  assert.equal(linkFits(record, { kind: "leave", store: "store-a" }, invited, NOW), "no");
  assert.equal(linkFits(record, { kind: "confirm", store: "store-a" }, { ...invited, address: "other@example.test" }, NOW), "no");
  assert.equal(linkFits(record, { kind: "confirm", store: "store-a" }, { ...invited, invitedAt: NOW }, NOW), "no", "invited again: the old link is dead");
  assert.equal(linkFits(record, { kind: "confirm", store: "store-a" }, undefined, NOW), "no", "removed from the list");
  assert.equal(linkFits(record, { kind: "confirm", store: "store-a" }, { ...invited, state: "left" }, NOW), "no", "left: confirm again only through a new invitation");
});

test("a leave link leaves in one press, and pressing it again changes nothing", () => {
  const record = linkRecord("leave", "store-a", confirmed);
  assert.equal(linkFits(record, { kind: "leave", store: "store-a" }, confirmed, NOW + 365 * DAY), "ok");
  assert.equal(linkFits(record, { kind: "leave", store: "store-a" }, invited, NOW), "ok", "an invited address can say no before it confirms");
  assert.equal(linkFits(record, { kind: "leave", store: "store-a" }, { ...confirmed, state: "left" }, NOW), "done");
});

test("a record in any other shape fits nothing", () => {
  const good = linkRecord("confirm", "store-a", invited);
  for (const bad of [null, {}, "x", { ...good, kind: "open" }, { ...good, invitedAt: "1" }, { ...good, store: "" }, { ...good, expiresAt: Number.NaN }, { ...good, kind: "leave", expiresAt: 5 }]) {
    assert.equal(linkFits(bad, { kind: "confirm", store: "store-a" }, invited, NOW), "no", JSON.stringify(bad));
  }
});
