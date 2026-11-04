import { test } from "node:test";
import assert from "node:assert/strict";
import { sesConfig, sesSend } from "./flow-stop-ses-network";

test("SES network bridge keeps the in-flight observer and never invents acceptance", async () => {
  const original = globalThis.fetch;
  let mode: "ok" | "refused" | "lost" | "missing-ack" | "server-error" = "ok";
  const seen: { url: string; subject: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), subject: JSON.parse(String(init?.body)).subject });
    if (mode === "lost") throw new TypeError("test lost reply");
    return new Response(JSON.stringify(mode === "ok" ? { id: "synthetic_accepted" } : {}), {
      status: mode === "refused" ? 400 : mode === "server-error" ? 500 : 200,
    });
  }) as typeof fetch;
  try {
    const config = sesConfig();
    assert.ok(config);
    const mail = { from: "a@example.com", to: "b@example.com", subject: "Still in flight", text: "Test only" };
    const accepted = await sesSend(config, mail);
    assert.equal(accepted.outcome, "sent");
    assert.deepEqual(seen, [{ url: "https://api.resend.com/emails", subject: mail.subject }]);
    for (const scenario of ["refused", "lost", "missing-ack", "server-error"] as const) {
      mode = scenario;
      const result = await sesSend(config, mail);
      assert.equal(result.outcome, scenario === "refused" ? "refused" : "busy");
      assert.equal(result.uncertain, scenario === "refused" ? undefined : true);
    }
    assert.equal(seen.length, 5, "one observation per actual SES POST");
  } finally { globalThis.fetch = original; }
});
