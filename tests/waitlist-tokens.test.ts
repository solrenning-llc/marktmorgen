import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WAIT_TOKEN, newWaitlistToken, waitlistTokenKey, parseStoreWaitlistGrant, parsePlatformWaitlistGrant } from "@/lib/waitlist-tokens";
import { CONFIRM_SECONDS, WAIT_SECONDS } from "@/lib/waitlist-rules";
const now = 1800000000;
const storeGrant = { s: "synthetic", h: "harbor-kitchen", p: "fictional", e: "creator@example.invalid", k: "confirm" as const };
const platform = { scope: "platform_waitlist", version: 1, entryId: "a".repeat(64), generation: "b".repeat(32), k: "confirm", issuedAt: now - 10, expiresAt: now + 60 };

test("legacy store token identities and grants remain compatible after extraction", () => {
  const token = "0123456789abcdef".repeat(3);
  assert.equal(WAIT_TOKEN.test(token), true);
  assert.equal(waitlistTokenKey(token), "nl:wl:t:" + createHash("sha256").update(token).digest("hex"));
  assert.deepEqual(parseStoreWaitlistGrant(JSON.stringify(storeGrant)), storeGrant);
  assert.deepEqual(parseStoreWaitlistGrant(JSON.stringify({ ...storeGrant, k: "leave" })), { ...storeGrant, k: "leave" });
  assert.equal(parseStoreWaitlistGrant("{bad"), null);
  assert.equal(parseStoreWaitlistGrant(JSON.stringify({ ...storeGrant, k: "launch" })), null);
});
for (const [name, changed] of [
  ["missing store id", { h: storeGrant.h, p: storeGrant.p, e: storeGrant.e, k: storeGrant.k }],
  ["missing handle", { s: storeGrant.s, p: storeGrant.p, e: storeGrant.e, k: storeGrant.k }],
  ["missing product", { s: storeGrant.s, h: storeGrant.h, e: storeGrant.e, k: storeGrant.k }],
  ["missing address", { s: storeGrant.s, h: storeGrant.h, p: storeGrant.p, k: storeGrant.k }],
  ["non-string store id", { ...storeGrant, s: 7 }],
  ["non-string handle", { ...storeGrant, h: null }],
  ["non-string product", { ...storeGrant, p: [] }],
  ["non-string address", { ...storeGrant, e: {} }],
  ["empty routing field", { ...storeGrant, p: "" }],
  ["control character", { ...storeGrant, h: "harbor\nother" }],
] as const) {
  test(`creator grant rejects ${name}`, () => {
    assert.equal(parseStoreWaitlistGrant(JSON.stringify(changed)), null);
  });
}
test("creator grant is byte-bounded", () => {
  assert.equal(parseStoreWaitlistGrant(JSON.stringify({ ...storeGrant, note: "x".repeat(2048) })), null);
});
test("creator grant returns only validated routing data", () => {
  assert.deepEqual(
    parseStoreWaitlistGrant(JSON.stringify({ ...storeGrant, email: "other@example.invalid", consent: true, paid: true })),
    storeGrant,
  );
});
for (const field of ["s", "h", "p", "e", "k"] as const) {
  test(`creator grant rejects conflicting duplicate ${field}`, () => {
    const first = field === "k" ? "leave" : "different";
    const raw = `{${JSON.stringify(field)}:${JSON.stringify(first)},${JSON.stringify(storeGrant).slice(1)}`;
    assert.equal(parseStoreWaitlistGrant(raw), null);
  });
}
test("creator grant rejects an escaped duplicate routing member", () => {
  const raw = '{"\\u0065":"other@example.invalid",' + JSON.stringify(storeGrant).slice(1);
  assert.equal(parseStoreWaitlistGrant(raw), null);
});
test("fresh opaque tokens do not carry an email or a reversible Redis key", () => {
  const first = newWaitlistToken(), second = newWaitlistToken();
  assert.match(first, WAIT_TOKEN);
  assert.match(second, WAIT_TOKEN);
  assert.notEqual(first, second);
  assert.notEqual(waitlistTokenKey(first), waitlistTokenKey(second));
  assert.equal(waitlistTokenKey(first).includes(first), false);
});
test("platform and creator grants cannot cross confirmation or leave flows", () => {
  assert.equal(parseStoreWaitlistGrant(JSON.stringify(platform)), null);
  assert.equal(parseStoreWaitlistGrant(JSON.stringify({ ...platform, k: "leave" })), null);
  assert.equal(parsePlatformWaitlistGrant(JSON.stringify(storeGrant), "confirm", now), null);
  assert.equal(parsePlatformWaitlistGrant(JSON.stringify(platform), "leave", now), null);
  assert.deepEqual(parsePlatformWaitlistGrant(JSON.stringify(platform), "confirm", now), platform);
});
test("platform grant validation rejects expiry, future issuance, unbounded lifetime and wrong identities", () => {
  for (const edit of [
    { expiresAt: now }, { issuedAt: now + 1 }, { issuedAt: -1 },
    { issuedAt: 1.5 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: platform.issuedAt + CONFIRM_SECONDS + 1 },
    { scope: "creator" }, { version: 2 }, { entryId: "a".repeat(63) },
    { entryId: "A".repeat(64) }, { generation: "" }, { generation: "x".repeat(32) },
  ]) assert.equal(parsePlatformWaitlistGrant(JSON.stringify({ ...platform, ...edit }), "confirm", now), null);
  const leave = { ...platform, k: "leave", expiresAt: platform.issuedAt + WAIT_SECONDS };
  assert.deepEqual(parsePlatformWaitlistGrant(JSON.stringify(leave), "leave", now), leave);
  assert.equal(parsePlatformWaitlistGrant(JSON.stringify({ ...leave, expiresAt: leave.expiresAt + 1 }), "leave", now), null);
});
test("malformed or oversized platform records and unknown clocks fail closed", () => {
  for (const raw of [null, 42, "", "{bad", "null", "[]", JSON.stringify({ ...platform, extra: "x".repeat(2048) })])
    assert.equal(parsePlatformWaitlistGrant(raw, "confirm", now), null);
  for (const clock of [-1, 0.5, NaN, Infinity]) assert.equal(parsePlatformWaitlistGrant(JSON.stringify(platform), "confirm", clock), null);
});
test("platform grants return only routing data and never imply consent or consumption", () => {
  assert.deepEqual(parsePlatformWaitlistGrant(JSON.stringify({ ...platform, email: "private@example.invalid", country: "BR", paid: true, consent: true }), "confirm", now), platform);
  const nextGeneration = { ...platform, generation: "c".repeat(32) };
  const parsed = parsePlatformWaitlistGrant(JSON.stringify(nextGeneration), "confirm", now);
  assert.equal(parsed?.generation, nextGeneration.generation);
  assert.notEqual(parsed?.generation, platform.generation);
});
for (const field of ["scope", "version", "entryId", "generation", "k", "issuedAt", "expiresAt"] as const) {
  test(`platform grant rejects conflicting duplicate ${field}`, () => {
    const first = typeof platform[field] === "number" ? 0 : "different";
    const raw = `{${JSON.stringify(field)}:${JSON.stringify(first)},${JSON.stringify(platform).slice(1)}`;
    assert.equal(parsePlatformWaitlistGrant(raw, "confirm", now), null);
  });
}
test("platform grant rejects an escaped duplicate routing member", () => {
  const raw = '{"\\u0065ntryId":"' + "c".repeat(64) + '",' + JSON.stringify(platform).slice(1);
  assert.equal(parsePlatformWaitlistGrant(raw, "confirm", now), null);
});
