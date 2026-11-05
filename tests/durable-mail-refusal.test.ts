import test from "node:test";
import assert from "node:assert/strict";
import { queuedShipmentMailSender, NIMBUS_FROM } from "@/lib/email";
import { createResendFallbackFixture } from "./resend-fallback-fixture";

const credential = "re_SYNTHETIC_TRANSPORT_ONLY";
const message = { from: "Store <owner@example.test>", to: "buyer@example.test", subject: "Existing right", text: "Original content", replyTo: "owner@example.test" };

test("durable fallback retains account and protocol refusals; only message validation is terminal", async t => {
  process.env.RESEND_API_KEY = credential;
  for (const key of ["AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "VERCEL_OIDC_TOKEN"]) delete process.env[key];
  for (const status of [400, 401, 403, 404, 405, 413, 415, 422, 429, 500]) {
    await t.test(String(status), async () => {
    const f = await createResendFallbackFixture({ credential, fetch: async () => Response.json({ message: "Synthetic refusal" }, { status }) });
    let barriers = 0;
    const result = await queuedShipmentMailSender(f.runtime)(message, async () => { barriers++; return true; }, { id: `status-${status}` });
    assert.equal(result, status === 422 ? "refused" : status >= 500 ? "unknown" : "not_accepted", String(status));
    assert.equal(barriers, 1);
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
    });
  }
});

test("durable creator mail uses the site fallback before its one-use dispatch barrier", async () => {
  const previous = process.env.MARKETING_FROM_DOMAIN;
  process.env.RESEND_API_KEY = credential;
  process.env.MARKETING_FROM_DOMAIN = "creators.example.test";
  try {
    const f = await createResendFallbackFixture({ credential, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { from: string };
      return body.from.includes("@creators.example.test")
        ? Response.json({ message: "Synthetic creator domain refused" }, { status: 403 })
        : Response.json({ id: "synthetic_site_accepted" });
    } });
    let barriers = 0;
    const result = await queuedShipmentMailSender(f.runtime)({ ...message, from: "Store <owner@creators.example.test>" },
      async () => ++barriers === 1, { id: "creator-site" });
    assert.equal(result, "accepted");
    const posts = f.requests.filter(r => r.method === "POST");
    assert.equal(posts.length, 1, "no second POST can bypass a durable one-use barrier");
    const sent = JSON.parse(posts[0].body!) as Record<string, unknown>;
    assert.equal(String(sent.from).includes(NIMBUS_FROM.match(/<([^>]+)>/)?.[1] ?? NIMBUS_FROM), true);
    assert.equal(sent.text, message.text);assert.equal(sent.reply_to, message.replyTo);assert.equal(barriers, 1);
  } finally {
    if (previous === undefined) delete process.env.MARKETING_FROM_DOMAIN;
    else process.env.MARKETING_FROM_DOMAIN = previous;
  }
});
