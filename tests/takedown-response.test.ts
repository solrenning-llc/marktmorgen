import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/takedown/route";
import { takedownAnswer } from "@/lib/takedown-response";
import { SESSION_COOKIE, openSession } from "@/lib/auth";

async function main() {
  let externalCalls = 0;
  globalThis.fetch = (async () => { externalCalls++; throw new Error("Unexpected external request"); }) as typeof fetch;
  // Only the operator acts on a notice (#4036; tests/takedown-operator-only.test.ts): the bodies are read as the operator.
  const cookie = `${SESSION_COOKIE}=${await openSession(process.env.DEMO_STUDIO_ADMIN ?? "")}`;
  const ask = (body: string, origin = "https://marktmorgen.com") => POST(new NextRequest("https://marktmorgen.com/api/takedown", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Host: "marktmorgen.com", Cookie: cookie }, body
  }));
  for (const body of ["null", "[]", "true", "false", "1", '"notice"', "["]) {
    const response = await ask(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid" });
  }
  const missing = await ask("{}");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { ok: false, error: "gone" });
  assert.equal((await ask("null", "https://example.test")).status, 403);
  assert.equal(externalCalls, 0);
  for (const raw of [null, [], {}, { ok: "true", done: "Removed" }, { ok: true }, { ok: true, done: "" },
    { ok: true, done: 1 }, { ok: true, done: "Removed", error: "error" },
    Object.create({ ok: true, done: "Removed" })]) {
    assert.equal(takedownAnswer(true, raw).ok, false);
  }
  assert.equal(takedownAnswer(false, { ok: true, done: "Removed" }).ok, false);
  assert.deepEqual(takedownAnswer(true, { ok: true, done: " Removed " }), { ok: true, done: "Removed" });
  assert.deepEqual(takedownAnswer(false, { ok: false, error: "nothing" }), { ok: false, nothing: true });
  console.log("Takedown confirmation: actual handler refuses malformed bodies without external calls; display requires HTTP and strict complete receipt.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
