/**
 * The AI alt text (app/api/store/ai/route.ts, `kind: "alt"`; lib/ai.ts, describePicture) reads the picture from the
 * file store only after the month's writing job is taken (6 November 2026, after the Blob review found the read came
 * first: a Creator store, whose AI_MONTHLY is 0, spent a paid Blob read on every request and was then refused).
 *
 * Each check sends the real route a real request from the creator's own session, with synthetic pictures in a file
 * store held in memory that counts every paid read (tests/alt-ai-order-world.ts) and the model played by a stand-in
 * for `fetch`:
 *
 *   - no allowance (Creator) and a month already used: the same refusal as before, no Blob read, no model call;
 *   - a store with its allowance: one read, one model call, one job taken;
 *   - a picture that cannot be read once the job is taken (missing, or the store not answering): the same refusal as
 *     before ("invalid"), no model call, and the job given back, since nothing billable started.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, imageFolder, setSubscription, storeForEmail } from "@/lib/store";
import { aiLeft, aiMonthKey } from "@/lib/ai";
import { store as redis } from "./redis-stub";
import { failing, files, reads } from "./alt-ai-order-world";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { POST } from "@/app/api/store/ai/route";

const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

let modelCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") return new Response("{}", { status: 404 });
  modelCalls += 1;
  return new Response(JSON.stringify({ content: [{ type: "text", text: "A loaf of rye bread on a wooden board." }], usage: { input_tokens: 10, output_tokens: 10 } }));
}) as typeof fetch;

const ask = async (session: string, body: unknown) => {
  const response = await POST(new NextRequest(`${ORIGIN}/api/store/ai`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const json = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; value?: string; left?: number };
  return { status: response.status, error: json.error ?? "ok", value: json.value ?? null, left: json.left ?? null };
};

async function creator(email: string, handle: string, tier: "creator" | "pro") {
  await claimHandle(email, handle, `Store ${handle}`, "");
  await ensureStatsId(email);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier, trialEnds: 0, period: paidPeriod() });
  const made = await addProduct(email, "Sunday Baking", "", "19", null);
  if (!made.ok) throw new Error("setup");
  const folder = await imageFolder(email);
  const path = `images/${folder}/${"a".repeat(32)}.jpg`;
  files.set(path, { bytes: JPEG, contentType: "image/jpeg" });
  return { session: await openSession(email), product: made.product.id, path, missing: `images/${folder}/${"b".repeat(32)}.jpg` };
}

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;

  part("No allowance: refused before the file store");
  const small = await creator("creator.alt@example.com", "creatoralt", "creator");
  reads.length = 0;
  modelCalls = 0;
  const none = await ask(small.session, { kind: "alt", product: small.product, path: small.path });
  is("a Creator store gets the same refusal as before", [none.status, none.error], [400, "used"]);
  is("and no Blob read and no model call were spent on it", [reads.length, modelCalls], [0, 0]);

  part("A month already used: refused before the file store");
  const studio = await creator("studio.alt@example.com", "studioalt", "pro");
  const store = (await storeForEmail("studio.alt@example.com"))!;
  const key = aiMonthKey(store, new Date())!;
  redis.run(["SET", key, "40"]);
  reads.length = 0;
  modelCalls = 0;
  const spent = await ask(studio.session, { kind: "alt", product: studio.product, path: studio.path });
  is("the same refusal as before", [spent.status, spent.error], [400, "used"]);
  is("no Blob read and no model call", [reads.length, modelCalls], [0, 0]);
  redis.run(["DEL", key]);

  part("With its allowance: one read, one model call");
  reads.length = 0;
  modelCalls = 0;
  const healthy = await ask(studio.session, { kind: "alt", product: studio.product, path: studio.path });
  is("described, one job taken", [healthy.status, healthy.value, healthy.left], [200, "A loaf of rye bread on a wooden board.", 39]);
  is("one read of the picture and one model call", [reads, modelCalls], [[`get ${studio.path}`], 1]);

  part("A picture that cannot be read once the job is taken");
  reads.length = 0;
  modelCalls = 0;
  const gone = await ask(studio.session, { kind: "alt", product: studio.product, path: studio.missing });
  is("a missing picture: the same refusal as before, no model call", [gone.status, gone.error, modelCalls], [400, "invalid", 0]);
  is("and the job given back", await aiLeft(store), 39);
  failing.on = true;
  const down = await ask(studio.session, { kind: "alt", product: studio.product, path: studio.path });
  failing.on = false;
  is("a file store not answering: the same refusal, no model call", [down.status, down.error, modelCalls], [400, "invalid", 0]);
  is("and the job given back", await aiLeft(store), 39);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
