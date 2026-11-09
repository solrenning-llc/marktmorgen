/** Real callback, counter and one-use consent; synthetic auth/funding/provider boundaries. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { finishMetaConnect } from "@/lib/meta-routes";
import { beginMeta } from "./meta-return-provider-world";
import { fixture, reset, state, SESSION_COOKIE } from "./meta-return-counter-world";

process.env.META_APP_ID = "123456789";
process.env.META_APP_SECRET = "synthetic-not-a-provider-secret";

async function request() {
  const consent = await beginMeta({
    statsId: fixture.statsId, sid: fixture.sid, sessionCookie: "synthetic-session",
    email: fixture.email, redirect: "https://example.invalid/callback",
  });
  const req = new NextRequest("https://example.invalid/callback?state=" + new URL(consent).searchParams.get("state") + "&code=synthetic-code", {
    headers: { cookie: SESSION_COOKIE + "=synthetic-session", "x-forwarded-for": "192.0.2.1" },
  });
  state.commands.length = 0;
  return req;
}

for (const mode of ["false-set", "null-count", "text-count", "timeout"]) {
  test("Meta unknown " + mode + " stops before consent and provider work", async () => {
    reset(); const req = await request(); state.counter = mode;
    const response = await finishMetaConnect(req);
    assert.equal(state.providerCalls, 0, "an unconfirmed counter must not authorize provider work");
    assert.equal(response.status, 303);
    const destination = new URL(response.headers.get("Location")!);
    assert.equal(destination.pathname, "/studio");
    assert.equal(destination.searchParams.get("metaads"), "error");
    assert.equal(destination.hash, "#numbers");
    assert.equal(await response.text(), "", "a full-page return must not display raw JSON");
    assert.deepEqual([state.accessCalls, state.fundingCalls, state.commands.length], [0, 0, 2]);
    assert.deepEqual(state.commands.map(command => command[0]), ["SET", "INCR"]);
    assert.equal(state.commands[0][3], "EX");
    assert.equal(state.commands[0][4], 600);
  });
}

for (const mode of ["empty", "partial"]) {
  test("Meta keeps the existing refusal for " + mode + " counter replies", async () => {
    reset(); const req = await request(); state.counter = mode;
    await finishMetaConnect(req);
    assert.equal(state.providerCalls, 0);
    assert.equal(state.commands.length, 2);
  });
}

test("Meta reports only a confirmed excess as slow", async () => {
  reset(); const req = await request(); state.counter = "exceeded";
  const response = await finishMetaConnect(req);
  assert.equal(state.providerCalls, 0);
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("Location")!).searchParams.get("metaads"), "limited");
  assert.equal(await response.text(), "");
  assert.equal(state.commands.length, 2);
});

for (const gate of ["configuration", "session", "state", "access", "pause", "funding"]) {
  test("Meta retains the independent " + gate + " refusal with a healthy counter", async () => {
    reset(); const req = await request();
    if (gate === "configuration") state.configured = false;
    if (gate === "session") state.session = false;
    if (gate === "state") req.nextUrl.searchParams.set("state", "invalid");
    if (gate === "access") state.access = false;
    if (gate === "pause") state.paused = "paused_unpaid";
    if (gate === "funding") state.funding = false;
    await finishMetaConnect(req);
    assert.equal(state.providerCalls, 0);
  });
}

test("Meta keeps a confirmed counter, one-use state and its original TTL", async () => {
  reset(); const req = await request(); const response = await finishMetaConnect(req);
  assert.equal(response.status, 303);
  assert.deepEqual([state.providerCalls, state.accessCalls, state.fundingCalls, state.commands.length], [1, 1, 1, 3]);
  assert.equal(state.commands[2][0], "GETDEL");
  assert.equal(state.commands[0][4], 600);
  await finishMetaConnect(req);
  assert.equal(state.providerCalls, 1, "a healthy replay cannot reuse consumed consent");
});

// Source contract only: the existing studio notice is not a browser/SSR certification.
test("Meta's existing error notice offers an honest retry instead of a slowdown", () => {
  const page = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  assert.match(page, /error:\s*{\s*title: "Something went wrong",\s*body: "Nothing was kept\. Try again in a moment\."/);
  // Rule 23: was `META_NOTICES[typeof params.metaads === "string" ? params.metaads : ""]`; the
  // notice is now read only from the table's own keys (tests/query-own-entry.test.ts).
  assert.ok(page.includes("ownEntry(META_NOTICES, params.metaads)"));
});
