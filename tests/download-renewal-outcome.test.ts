import assert from "node:assert/strict";
import { test } from "node:test";
import type { NextRequest } from "next/server";
import { paidDownloadGet, paidDownloadRenewalPost } from "@/app/api/store/download/route";
import { renewalFixture, request, tokenKeys } from "./single-digital-access-renewal-world";
import { store as redis } from "./redis-stub";

for (const outcome of ["refunded", "unpaid"] as const) {
  for (const method of ["GET", "POST"] as const) {
    test(`expired original ${method} returns clear 410 for ${outcome}, without a renewal or token`, async () => {
      const f = await renewalFixture();
      if (outcome === "refunded") {
        f.session.payment_intent.latest_charge.refunded = true;
        f.session.payment_intent.latest_charge.amount_refunded = 3500;
      } else f.session.payment_status = "unpaid";
      const before = f.gets.length;
      const response = method === "GET"
        ? await paidDownloadGet({ nextUrl: f.url, headers: new Headers() } as NextRequest, f.runtime)
        : await paidDownloadRenewalPost(request(f.url, new URLSearchParams({ handle: f.store.handle, origin: f.url.searchParams.get("origin")!, request: "a".repeat(64) })), f.runtime);
      assert.equal(response.status, 410);
      const body = await response.text();
      assert.match(body, /no longer paid|refunded/i);
      assert.equal(body.includes("<form"), false);
      assert.equal(tokenKeys().length, 0);
      assert.equal([...redis.keys()].some(key => key.startsWith("nl:order-confirmation:row:")), false);
      assert.equal(f.gets.length - before, 1, "exactly one current-payment lookup per renewal request");
    });
  }
}

for (const method of ["GET", "POST"] as const) {
  test(`expired original ${method} keeps provider failure retryable, without offering or saving renewal`, async () => {
    const f = await renewalFixture();
    globalThis.fetch = async () => { throw Error("SYNTHETIC_PROVIDER_UNAVAILABLE"); };
    const response = method === "GET"
      ? await paidDownloadGet({ nextUrl: f.url, headers: new Headers() } as NextRequest, f.runtime)
      : await paidDownloadRenewalPost(request(f.url, new URLSearchParams({ handle: f.store.handle, origin: f.url.searchParams.get("origin")!, request: "a".repeat(64) })), f.runtime);
    assert.ok([502, 503].includes(response.status));
    const body = await response.text();
    assert.match(body, /try again/i);
    assert.equal(body.includes("<form"), false);
    assert.equal(tokenKeys().length, 0);
    assert.equal([...redis.keys()].some(key => key.startsWith("nl:order-confirmation:row:")), false);
  });
}

for (const method of ["GET", "POST"] as const) {
  test(`expired original ${method} treats missing payment evidence as retryable unknown`, async () => {
    const f = await renewalFixture();
    delete (f.session.payment_intent as unknown as Record<string, unknown>).latest_charge;
    const before = f.gets.length;
    const response = method === "GET"
      ? await paidDownloadGet({ nextUrl: f.url, headers: new Headers() } as NextRequest, f.runtime)
      : await paidDownloadRenewalPost(request(f.url, new URLSearchParams({ handle: f.store.handle, origin: f.url.searchParams.get("origin")!, request: "a".repeat(64) })), f.runtime);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("<form"), false);
    assert.equal(f.gets.length - before, 1);
    assert.equal(tokenKeys().length, 0);
    assert.equal([...redis.keys()].some(key => key.startsWith("nl:order-confirmation:row:")), false);
  });
}
