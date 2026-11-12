/**
 * sendEmailOutcome (lib/email.ts) when the guarded Resend transport stops
 * before it makes any request (Claude 2's MEDIUM 2 on #3377).
 *
 * guardedResendPost (lib/resend-fallback-transport.ts) answers "unknown" both
 * when its POST may have reached Resend and when it stopped before any POST:
 * the /usage read failed, a reservation or dispatch reply was lost, or the
 * deadline passed before the fetch. Read alike, a five-minute job keeps its
 * mark on a reminder that never left, and the reminder is lost (a call's
 * "a day before and an hour before", lib/buyer-words/booking.ts). Only a POST
 * that may have been made is "uncertain"; a stop before any POST is
 * "refused", so the job tries again. Synthetic account, usage reply and ACK
 * boundary (tests/resend-fallback-fixture.ts) over the real transport; no
 * real email is sent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { sendEmailOutcome } from "@/lib/email";
import { createResendFallbackFixture } from "./resend-fallback-fixture";
import { store } from "./redis-stub";

const credential = "re_SYNTHETIC_TRANSPORT_ONLY";
process.env.RESEND_API_KEY = credential;
for (const name of ["RESEND_READ_API_KEY", "RESEND_CREATORS_API_KEY", "AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "VERCEL_OIDC_TOKEN", "VERCEL"]) delete process.env[name];

const message = { meter: { by: "order" as const }, from: "Shop <shop@example.test>", to: "buyer@example.test", subject: "Tomorrow: a call", text: "Synthetic reminder" };
type Fixture = Awaited<ReturnType<typeof createResendFallbackFixture>>;
const posts = (f: Fixture) => f.requests.filter((r) => r.method === "POST").length;
const reply = (status: number): typeof fetch => async () => (status === 200 ? Response.json({ id: "synthetic_accepted" }) : Response.json({ message: "synthetic" }, { status }));

/** The fixture's runtime, with its /usage read answered by `usage` instead. */
function usageAnswers(f: Fixture, usage: () => Promise<Response>) {
  const inner = f.runtime.fetch!;
  return { ...f.runtime, fetch: (async (input, init) => (new URL(String(input)).pathname === "/usage" ? usage() : inner(input, init))) as typeof fetch };
}

test("a stop before any POST is a certain refusal, so the job tries again", async (t) => {
  await t.test("the /usage read answered 500", async () => {
    store.clear();
    const f = await createResendFallbackFixture({ credential, fetch: reply(200) });
    assert.equal(await sendEmailOutcome(message, usageAnswers(f, async () => Response.json({ message: "down" }, { status: 500 }))), "refused");
    assert.equal(posts(f), 0, "nothing was posted");
  });
  await t.test("the /usage read threw", async () => {
    store.clear();
    const f = await createResendFallbackFixture({ credential, fetch: reply(200) });
    assert.equal(await sendEmailOutcome(message, usageAnswers(f, async () => { throw new TypeError("fetch failed"); })), "refused");
    assert.equal(posts(f), 0, "nothing was posted");
  });
  await t.test("the reservation's reply was lost", async () => {
    store.clear();
    const f = await createResendFallbackFixture({ credential, fetch: reply(200) });
    f.loseNext("reserve");
    assert.equal(await sendEmailOutcome(message, f.runtime), "refused");
    assert.equal(posts(f), 0, "nothing was posted");
  });
  await t.test("the dispatch mark's reply was lost", async () => {
    store.clear();
    const f = await createResendFallbackFixture({ credential, fetch: reply(200) });
    f.loseNext("dispatch");
    assert.equal(await sendEmailOutcome(message, f.runtime), "refused");
    assert.equal(posts(f), 0, "nothing was posted");
  });
  await t.test("the dispatch deadline passed before the fetch", async () => {
    store.clear();
    const f = await createResendFallbackFixture({ credential, fetch: reply(200) });
    const clock = Date.now;
    const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
    // Each read of the monotonic clock is a second later: the dispatch's one-second window is gone at the last check.
    let at = 100;
    try {
      Object.defineProperty(performance, "now", { configurable: true, value: () => (at += 1_000) });
      assert.equal(await sendEmailOutcome(message, f.runtime), "refused");
    } finally {
      Date.now = clock;
      if (descriptor) Object.defineProperty(performance, "now", descriptor);
      else Reflect.deleteProperty(performance, "now");
    }
    assert.equal(posts(f), 0, "nothing was posted");
  });
});

test("controls: a POST that may have reached Resend stays uncertain; a documented refusal is refused", async (t) => {
  for (const [label, fetcher, expected] of [
    ["a 500 after the POST", reply(500), "uncertain"],
    ["a 409 after the POST (an idempotency conflict may describe an earlier acceptance)", reply(409), "uncertain"],
    ["the POST threw", (async () => { throw new TypeError("fetch failed: the connection was reset"); }) as typeof fetch, "uncertain"],
    ["a 422 after the POST", reply(422), "refused"],
    ["a plain yes", reply(200), "sent"],
  ] as const) {
    await t.test(label, async () => {
      store.clear();
      const f = await createResendFallbackFixture({ credential, fetch: fetcher });
      assert.equal(await sendEmailOutcome(message, f.runtime), expected);
      assert.equal(posts(f), 1, "posted once");
    });
  }
});
