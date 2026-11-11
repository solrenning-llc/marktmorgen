import test from "node:test";
import assert from "node:assert/strict";
import { readFeedToken } from "@/lib/podcast-access";
import { UnknownReplyError } from "@/lib/redis-reply";
import { reset, calls } from "./podcast-grant-read-world";

const token = "a".repeat(48);
const grant = { s: "b".repeat(32), h: "synthetic-audio", p: "c".repeat(32), e: "listener@example.invalid" };

globalThis.fetch = async () => {
  throw new Error("No provider I/O allowed");
};

async function refuses(reply: unknown[]) {
  reset(reply);
  assert.equal(await readFeedToken(token), null);
  assert.equal(calls.length, 1);
}

// Since main's rule 24 (lib/podcast-access.ts readFeedToken), a reply in an unknown shape throws UnknownReplyError,
// so the feed answers a server error its app asks again after: still never a confirmed grant.
test("extra pipeline result is unknown, not a confirmed feed grant", async () => {
  reset([JSON.stringify(grant), null]);
  await assert.rejects(readFeedToken(token), UnknownReplyError);
  assert.equal(calls.length, 1);
});

for (const [name, row] of [
  ["missing handle", { s: grant.s, p: grant.p, e: grant.e }],
  ["non-string handle", { ...grant, h: 17 }],
  ["empty store", { ...grant, s: "" }],
  ["empty product", { ...grant, p: "" }],
  ["empty address", { ...grant, e: "" }],
] as const) {
  test(`routing evidence rejects ${name}`, () => refuses([JSON.stringify(row)]));
}

for (const field of ["s", "h", "p", "e"] as const) {
  test(`duplicate ${field} is ambiguous`, () =>
    refuses([`{${JSON.stringify(field)}:"different",${JSON.stringify(grant).slice(1)}`]));
}

test("escaped duplicate address is ambiguous", () =>
  refuses(['{"\\u0065":"other@example.invalid",' + JSON.stringify(grant).slice(1)]));

test("unknown claims are not propagated with routing data", async () => {
  reset([JSON.stringify({ ...grant, consent: true, paid: true })]);
  assert.deepEqual(await readFeedToken(token), grant);
  assert.equal(calls.length, 1);
});

test("exact valid grant is preserved", async () => {
  reset([JSON.stringify(grant)]);
  assert.deepEqual(await readFeedToken(token), grant);
  assert.equal(calls.length, 1);
});

test("confirmed missing grant remains absent", () => refuses([null]));

test("malformed and incomplete JSON remain refused", async () => {
  for (const raw of ["{bad", "null", "[]", "{}", JSON.stringify({ h: grant.h })]) await refuses([raw]);
});

test("invalid token performs zero reads", async () => {
  reset([JSON.stringify(grant)]);
  assert.equal(await readFeedToken("not-a-feed-token"), null);
  assert.equal(calls.length, 0);
});
