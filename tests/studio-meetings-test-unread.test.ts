/**
 * The Video calls page (app/studio/meetings/page.tsx) reads the test meeting
 * each connected account has (lib/meet-test.ts, readTests). When that read
 * fails, the page must not draw the account as having none: "Make a test
 * meeting" there is an offer to make a real meeting on the creator's account
 * over one that may already be there (CX-123 rule 24). It says the test
 * meeting could not be read and offers no button that assumes it is absent;
 * a confirmed empty read and a healthy one are drawn as before.
 *
 * Synthetic store, session and Redis (tests/redis-stub.ts); every outbound
 * request throws, so no provider is reached.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import StudioMeetingsPage from "@/app/studio/meetings/page";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";

globalThis.fetch = (async () => {
  throw Error("Unexpected external request in synthetic page journey");
}) as typeof fetch;

const NAMES = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"];
const MAKE = "Make a test meeting";
const HAS = "A test meeting is on your";
const UNREAD = "We could not read your test meeting just now.";

test("an unread test meeting is said as unread, never drawn as none with a button to make one", async () => {
  const before = NAMES.map((name) => process.env[name]);
  const pipeline = redis.pipeline.bind(redis);
  try {
    for (const name of NAMES) delete process.env[name];
    process.env.GOOGLE_OAUTH_CLIENT_ID = "synthetic-client";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "synthetic-secret";
    redis.clear();
    cookieValues.clear();
    const email = "meet-test-unread@example.com";
    await claimHandle(email, "meettestunread", "A store", "");
    await ensureStatsId(email);
    await setSubscription(email, { customerId: "cus_MeetUnread01", subscriptionId: "sub_MeetUnread01", active: true, tier: "creator", cycle: "month", period: paidPeriod() });
    const store = (await storeForEmail(email))!;
    assert.ok(store.statsId);
    cookieValues.set(SESSION_COOKIE, await openSession(email));
    const testKey = `nl:meet:test:${store.statsId}:google`;
    await redisPipeline([
      ["SET", `nl:meet:conn:${store.statsId}:google`, JSON.stringify({ provider: "google", account: { id: "synthetic-account", email: "host@example.test", name: "Host" }, access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, scope: "", connectedAt: 1, by: email, owner: { email, handle: store.handle }, broken: "", brokenAt: 0 })],
      ["SET", testKey, JSON.stringify({ id: "synthetic-meeting", link: "https://meet.example.test/abc", start: Date.now() + 3_600_000, end: Date.now() + 5_400_000, madeAt: Date.now() })],
    ]);
    const visit = async () => renderToStaticMarkup(await StudioMeetingsPage({ searchParams: Promise.resolve({}) }));

    // Healthy: the test meeting is drawn, with no offer to make another.
    const healthy = await visit();
    assert.ok(healthy.includes("host@example.test"), "the connected account is drawn");
    assert.ok(healthy.includes(HAS), "a healthy read shows the test meeting");
    assert.equal(healthy.includes(MAKE), false, "no second test meeting is offered over the first");
    assert.equal(healthy.includes(UNREAD), false);

    // Unknown: the test-meeting read fails. The account may have one; the page must not say it has none.
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((command) => command[0] === "GET" && command[1] === testKey)) throw Error("synthetic Redis failure on the test-meeting read");
      return pipeline(commands);
    }) as typeof redis.pipeline;
    const unread = await visit();
    assert.ok(unread.includes("host@example.test"), "the connection itself is still drawn");
    assert.equal(unread.includes(MAKE), false, "an unread test meeting is not offered as one to make");
    assert.equal(unread.includes(HAS), false, "nor drawn as there");
    assert.ok(unread.includes(UNREAD), "it says the test meeting could not be read");
    redis.pipeline = pipeline;

    // Confirmed empty: no test meeting on record, so the button to make one is offered as before.
    await redisPipeline([["DEL", testKey]]);
    const empty = await visit();
    assert.ok(empty.includes(MAKE), "a confirmed absent test meeting offers to make one");
    assert.equal(empty.includes(HAS), false);
    assert.equal(empty.includes(UNREAD), false);
  } finally {
    redis.pipeline = pipeline;
    cookieValues.clear();
    NAMES.forEach((name, index) => {
      if (before[index] === undefined) delete process.env[name];
      else process.env[name] = before[index];
    });
  }
});
