import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/creators/route";
import { isSavedCreatorAnswer } from "@/lib/creator-research";
import { RESPONSES_KEY } from "@/lib/creator-research-store";
import { store } from "./redis-stub";

async function main() {
  let externalCalls = 0;
  globalThis.fetch = (async () => { externalCalls++; throw new Error("Unexpected external request"); }) as typeof fetch;
  const payload = {
    name: "Synthetic Creator", email: "creator@example.test", platform: "Other",
    country: "Test country", problem: "A synthetic research answer for a regression test.",
    link: "", tools: "", cost: "", consentResearch: true,
    consentFollowUp: false, consentUpdates: false, website: ""
  };
  const ask = (body: unknown, ip: string, origin = "https://marktmorgen.com") => POST(
    new NextRequest("https://marktmorgen.com/api/creators", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin,
        Host: "marktmorgen.com", "x-forwarded-for": ip }, body: JSON.stringify(body)
    })
  );
  for (const raw of [null, [], true, {}, {ok: true}, {ok: "true", saved: true},
    {ok: true, saved: "true"}, {ok: true, saved: false}, {ok: true, saved: true, error: null},
    {ok: true, saved: true, field: "name"}, Object.create({ok: true, saved: true})]) {
    assert.equal(isSavedCreatorAnswer(true, raw), false);
  }
  assert.equal(isSavedCreatorAnswer(false, {ok: true, saved: true}), false);
  assert.equal(isSavedCreatorAnswer(true, {ok: true, saved: true}), true);
  const bot = await ask({...payload, website: "bot-filled"}, "192.0.2.1");
  assert.equal(bot.status, 201);
  assert.equal(isSavedCreatorAnswer(bot.ok, await bot.json()), false);
  assert.deepEqual(await store.pipeline([["LRANGE", RESPONSES_KEY, 0, -1]]), [[]]);
  const accepted = await ask(payload, "192.0.2.2");
  assert.equal(accepted.status, 201);
  assert.equal(isSavedCreatorAnswer(accepted.ok, await accepted.json()), true);
  const [rows] = await store.pipeline([["LRANGE", RESPONSES_KEY, 0, -1]]);
  assert.equal((rows as string[]).length, 1);
  const saved = JSON.parse((rows as string[])[0]);
  assert.equal(saved.problem, payload.problem);
  assert.equal(saved.consentFollowUp, false);
  assert.equal(saved.consentUpdates, false);
  assert.equal((await ask({...payload, consentResearch: false}, "192.0.2.3")).status, 400);
  assert.equal((await ask(payload, "192.0.2.4", "https://example.test")).status, 403);
  const pipeline = store.pipeline.bind(store);
  store.pipeline = async commands => commands.some(command => command[0] === "LPUSH" || command[0] === "EVAL") ? [undefined] : pipeline(commands);
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  const unconfirmed = await ask(payload, "192.0.2.5");
  console.error = originalError;
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "creator research submission failed");
  assert.equal(unconfirmed.status, 500);
  assert.equal(isSavedCreatorAnswer(unconfirmed.ok, await unconfirmed.json()), false);
  store.pipeline = pipeline;
  assert.equal(externalCalls, 0);
  console.log("Creator research: actual handler confirms storage, preserves consent, distinguishes honeypot and unconfirmed writes without external calls.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
