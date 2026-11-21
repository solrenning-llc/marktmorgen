/**
 * The creator's legacy Blob upload route keeps ordinary admission refusals
 * as refusals, rather than reporting a server failure. The route is real;
 * authentication and the SDK use the existing canonical upload seams.
 * No positive upload, SDK security or real authentication is certified.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/file/route";
import { admission, type Refusal } from "./file-upload-admission-world";
import { resetWorld, state, FOLDER } from "./upload-route-world";
import { reset, calls } from "./upload-budget-redis";
import { DOOR_ECHO_HEADER } from "@/lib/upload-door";

const scenarios: readonly [Refusal, number][] = [["locked", 403], ["signed_out", 401], ["forbidden", 403], ["gone", 403], ["used", 429], ["two_step", 403]];

for (const [reason, expectedStatus] of scenarios) {
  test(`legacy file upload answers ${reason} with HTTP ${expectedStatus}`, async () => {
    reset();
    resetWorld();
    admission.reason = reason;
    admission.calls = 0;
    admission.needs.length = 0;
    admission.message = "Synthetic admission refusal";
    let networkAttempts = 0;
    const previousFetch = globalThis.fetch;
    const previousError = console.error;
    globalThis.fetch = async () => { networkAttempts += 1; throw new Error("External calls are forbidden in this synthetic test"); };
    console.error = () => {};
    try {
      const request = new Request("https://upload.example.test/api/store/file", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://upload.example.test" },
        // upload-route-world invokes the real getSignedToken callback with
        // this body; this is not a claim about the real SDK wire protocol.
        body: JSON.stringify({ pathname: `stores/${FOLDER}/product-1/file.pdf`, clientPayload: JSON.stringify({ productId: "product-1" }) }),
      }) as NextRequest;
      const response = await POST(request);
      const body: unknown = await response.json();
      const commands = calls.reduce((total, batch) => total + batch.length, 0);
      assert.equal(admission.calls, 1, "admission is checked once, without replay");
      assert.deepEqual(admission.needs, ["products"]);
      assert.ok(commands <= 2000, "the synthetic command ceiling remains bounded");
      assert.equal(commands, 0, "admission refusal precedes budget or Redis work");
      assert.deepEqual(state.events, [], "no storage measurement, provider work or token issuance");
      assert.equal(networkAttempts, 0);
      assert.equal(response.status, expectedStatus);
      assert.deepEqual(body, { ok: false, error: reason, message: "Synthetic admission refusal" });
    } finally {
      globalThis.fetch = previousFetch;
      console.error = previousError;
    }
  });
}

test("an uncountable studio action keeps its own words, never just \"used\" (Claude 5 LEVE)", async () => {
  reset();
  resetWorld();
  admission.reason = "used";
  admission.calls = 0;
  admission.needs.length = 0;
  // countStudio's words when the figure could not be read (why: "unknown").
  admission.message = "This can't be counted right now. Try again in a minute.";
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  globalThis.fetch = async () => { throw new Error("External calls are forbidden in this synthetic test"); };
  console.error = () => {};
  try {
    const request = new Request("https://upload.example.test/api/store/file", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://upload.example.test" },
      body: JSON.stringify({ pathname: `stores/${FOLDER}/product-1/file.pdf`, clientPayload: JSON.stringify({ productId: "product-1" }) }),
    }) as NextRequest;
    const response = await POST(request);
    const body = await response.json() as { ok: boolean; error: string; message?: string };
    assert.equal(response.status, 429, "the same status as the sibling download route's refusedJson");
    assert.equal(body.error, "used");
    assert.equal(body.message, admission.message, "the reader is told the count could not be read, not that it was used up");
    assert.deepEqual(state.events, [], "still nothing measured, signed or issued");
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousError;
  }
});

/** The client's second ask, carrying a door the studio already holds (lib/upload-door.ts). */
async function echoAsk(header: string): Promise<{ status: number; body: unknown; commands: number }> {
  reset();
  resetWorld();
  admission.reason = "used";
  admission.calls = 0;
  admission.needs.length = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("External calls are forbidden in this synthetic test"); };
  try {
    const request = new Request("https://upload.example.test/api/store/file", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://upload.example.test", [DOOR_ECHO_HEADER]: header },
      body: JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname: `stores/${FOLDER}/product-1/file.pdf`, clientPayload: JSON.stringify({ productId: "product-1" }), multipart: false } }),
    }) as NextRequest;
    const response = await POST(request);
    return { status: response.status, body: await response.json(), commands: calls.reduce((total, batch) => total + batch.length, 0) };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("the echo hands back exactly the door it carries, with no admission, count, budget or signing", async () => {
  const door = { delegationToken: "synthetic.token", signature: "synthetic-signature", params: { pathname: `stores/${FOLDER}/product-1/file.pdf` } };
  const answer = await echoAsk(JSON.stringify(door));
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { type: "blob.generate-presigned-url", presignedUrlPayload: door });
  assert.equal(admission.calls, 0, "the studio action is counted once, on the real ask, never on the echo");
  assert.equal(answer.commands, 0, "no Redis work");
  assert.deepEqual(state.events, [], "no storage measurement, provider work or token issuance");
});

test("an echo header that is not a door is refused, never taken for a first ask", async () => {
  for (const header of ["", "not json", "[]", JSON.stringify({ delegationToken: "a.b", signature: "s" }), JSON.stringify({ delegationToken: "a.b", signature: "s", params: {}, extra: 1 }), JSON.stringify({ delegationToken: "a.b", signature: "s", params: { p: 1 } }), "x".repeat(9_000)]) {
    const answer = await echoAsk(header);
    assert.equal(answer.status, 400, header.slice(0, 40));
    assert.deepEqual(answer.body, { ok: false, error: "invalid" });
    assert.equal(admission.calls, 0);
    assert.equal(answer.commands, 0);
    assert.deepEqual(state.events, []);
  }
});
