/**
 * Review proof: every studio admission refusal remains an admission refusal.
 * The legacy upload route must not turn a session lock into a server error.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/file/route";
import { admission } from "./file-upload-admission-world";
import { resetWorld, state, FOLDER } from "./upload-route-world";
import { reset, calls } from "./upload-budget-redis";

test("legacy file upload preserves a locked studio refusal", async () => {
  reset();
  resetWorld();
  admission.reason = "locked";
  admission.calls = 0;
  admission.needs.length = 0;

  const request = new Request("https://upload.example.test/api/store/file", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://upload.example.test" },
    body: JSON.stringify({
      pathname: `stores/${FOLDER}/product-1/file.pdf`,
      clientPayload: JSON.stringify({ productId: "product-1" }),
    }),
  }) as NextRequest;

  const previousError = console.error;
  console.error = () => {};
  try {
    const response = await POST(request);
    assert.equal(admission.calls, 1);
    assert.deepEqual(admission.needs, ["products"]);
    assert.equal(calls.reduce((total, batch) => total + batch.length, 0), 0);
    assert.deepEqual(state.events, []);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, error: "locked" });
  } finally {
    console.error = previousError;
  }
});
