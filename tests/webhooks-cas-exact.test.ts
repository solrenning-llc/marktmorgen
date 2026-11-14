/**
 * The webhook settings' compare-and-set and the resend's mark read the script's reply only in its exact shape
 * (lib/webhooks.ts changeConfig and resendDelivery; CX-123 rules 24 and 30).
 *
 * The script (SAVE_CRM_PIPELINES v2 in lib/crm.ts, modelled by lib/redis-memory.ts) answers 1 when it wrote, and
 * [-1] or [-1, n] when the text there was not the one read. Any other reply, or a call that fails, is unknown: a
 * settings change reads the settings back once, exactly. The text written means saved (told as saved, its secret
 * handed out); the text read means not written (made again from it, as for [-1]); anything else, or a read back in
 * another shape, stays unsure, and the words say it may have been saved, never "Nothing was changed". Settings
 * text that is not settings is unknown, never "no settings". A resend sends nothing on an unknown mark and answers
 * that it could not be sent just now, and the original keeps the time it had left: the resend's mark is its own
 * script (RESEND_MARK in lib/webhooks.ts, same compare and replies), whose write keeps the key's expiry (KEEPTTL),
 * while the settings' script's SET clears it, in real Redis and in the in-memory model alike. The reads beside the
 * resend's mark (the delivery with its time left, and the last resend) are exact too.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts); no request leaves (the address resolver refuses).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as studioRoute } from "@/app/api/store/webhooks/route";
import { DELETE as apiRemove, POST as apiAdd } from "@/app/api/v1/hooks/route";
import { makeKey } from "@/lib/api-keys";
import { makerFor } from "@/lib/api-key-pause";
import { SAVE_CRM_PIPELINES } from "@/lib/crm";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { addEndpoint, emitEvent, removeEndpoint, resendDelivery, rotateSecret, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;
/** Every call to an endpoint first resolves its address: counting those counts what was sent (none leaves). */
let sends = 0;
setSendHooksForTests({ fetch: { resolve: (async () => { sends += 1; throw new Error("no network in tests"); }) as never } });

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const SETTINGS_CAS = "-- marktmorgen:crm-pipelines-save:v2\n";
/** The settings' compare-and-set or the resend's mark (RESEND_MARK): the same compare, the same replies. */
const isCas = (c: Command) => c[0] === "EVAL" && (String(c[1]).startsWith(SETTINGS_CAS) || String(c[1]).startsWith("-- marktmorgen:webhook-resend-mark:v1\n"));
/** A reply standing for a call that fails (the connection closed). */
const FAILS = Symbol("the call fails");
/** While set, a compare-and-set is not run: this is its reply (FAILS: the call fails). */
let casReply: { value: unknown } | null = null;
/** While set, a compare-and-set is run, and then its reply is replaced by this (FAILS: the call fails after it ran). */
let casLanded: { value: unknown } | null = null;
/** While set, run right after a compare-and-set that landed: another change landing at once. */
let meanwhile: (() => Promise<unknown>) | null = null;
/** While set, the first GET of a store's webhook settings after a compare-and-set (the read back) answers this. */
let readBack: { value: unknown } | null = null;
let readBackArmed = false;
let casCalls = 0;
/** While set, the reply to each other command it matches is replaced by what it returns (the command still runs). */
let bend: ((command: Command, reply: unknown) => unknown) | null = null;
redis.pipeline = (async (commands: Command[]) => {
  // The queue's lease is not taken here, so the event's first try waits (no network either way).
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) return [0];
  if (commands.length === 1 && isCas(commands[0])) {
    casCalls += 1;
    readBackArmed = true;
    if (casReply) {
      if (casReply.value === FAILS) throw new Error("the connection closed");
      return [casReply.value];
    }
    if (casLanded) {
      await real(commands);
      // Real Redis's SET inside the settings' script clears the key's expiry (it has no KEEPTTL), whatever the model
      // does; the resend's mark keeps it (KEEPTTL), as real Redis does, so nothing is cleared for it here.
      if (String(commands[0][1]).startsWith(SETTINGS_CAS)) await real([["PERSIST", String(commands[0][3])]]);
      if (meanwhile) await meanwhile();
      if (casLanded.value === FAILS) throw new Error("the connection closed after the write");
      return [casLanded.value];
    }
  }
  if (readBack && readBackArmed && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:hooks:cfg:")) {
    readBackArmed = false;
    return [readBack.value];
  }
  const replies = await real(commands);
  if (bend) commands.forEach((c, i) => { replies[i] = bend!(c, replies[i]); });
  return replies;
}) as typeof redis.pipeline;

/** How a promise ended: its value, "unknown" for UnknownReplyError, or the other error's message. */
async function outcome<T>(work: Promise<T>): Promise<T | string> {
  try {
    return await work;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw: ${(error as Error).message}`;
  }
}

/** A resend's answer in short: "sent" when it went, else its reason. */
const brief = (result: Awaited<ReturnType<typeof resendDelivery>> | string) => (typeof result === "string" ? result : result.ok ? "sent" : result.reason);

const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;
const OWNER = "owner-cas-exact@example.com";
const OFF_SHAPES: [string, unknown][] = [
  ['"1"', "1"],
  ["true", true],
  ["[1]", [1]],
  ['"1.0"', "1.0"],
  ["null", null],
  ["undefined", undefined],
  ["an object", { ok: 1 }],
  ['[-1, "x"]', [-1, "x"]],
  ["[-1, -5]", [-1, -5]],
  ["[-1, 3, 4]", [-1, 3, 4]],
  ["[]", []],
];
/** The same, and a call that fails. */
const UNKNOWN: [string, unknown][] = [...OFF_SHAPES, ["a call that fails", FAILS]];
const KEPT_CHANGING = "threw: The webhook settings kept changing while being saved.";
const ttlOf = async (key: string) => (await real([["PTTL", key]]))[0] as number;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "cas-exact-shop", "Cas Exact Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_CasExact00001", subscriptionId: "sub_CasExact00001", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const cfg = `nl:hooks:cfg:${statsId}`;
  const added = await addEndpoint(store, "https://hooks.example.com/cas", ["sale.completed"]);
  if (!added.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added)}`);
  const endpointId = (await webhooksView(store)).endpoints[0].id;
  is("setup: a sale is written for the endpoint", await emitEvent(store, "sale.completed", "cs_test_CasExact01", { amount_cents: 6900 }), 1);
  const failedId = (await webhooksView(store)).log[0].id;
  const original = `nl:hooks:d:${failedId}`;
  const [rawDelivery] = await real([["GET", original]]);
  await real([["SET", original, JSON.stringify({ ...JSON.parse(String(rawDelivery)), state: "failed", attempts: 7, next: null }), "EX", 3600]]);
  const [failedRaw] = await real([["GET", original]]);
  const settings = async () => (await real([["GET", cfg]]))[0];

  part("Settings: an unknown reply that did not land is read back, found not written, made again from it, never said saved");
  for (const [name, value] of UNKNOWN) {
    const before = await settings();
    casReply = { value };
    casCalls = 0;
    const rotated = await outcome(rotateSecret(store, endpointId));
    const rotateCalls = casCalls;
    casCalls = 0;
    const another = await outcome(addEndpoint(store, "https://hooks.example.com/another", ["sale.completed"]));
    const addCalls = casCalls;
    casReply = null;
    is(`${name}: replacing the secret is made again on each read back, then refused; no secret handed out`, [typeof rotated === "string" ? rotated : "a secret", rotateCalls], [KEPT_CHANGING, 4]);
    is(`${name}: adding an endpoint is made again on each read back, then refused; no secret handed out`, [typeof another === "string" ? another : "a secret", addCalls], [KEPT_CHANGING, 4]);
    is(`${name}: the settings are as they were`, (await settings()) === before, true);
  }

  part("Settings: an unknown reply that did land is read back and told saved, its secret handed out once");
  for (const [name, value] of UNKNOWN) {
    casLanded = { value };
    casCalls = 0;
    const rotated = await outcome(rotateSecret(store, endpointId));
    const rotateCalls = casCalls;
    casCalls = 0;
    const another = await outcome(addEndpoint(store, "https://hooks.example.com/landed", ["sale.completed"]));
    const addCalls = casCalls;
    casLanded = null;
    const now = String(await settings());
    is(`${name}: the secret replaced, tried once, the secret handed out is the one saved`,
      [typeof rotated === "string" ? rotated : rotated.ok, rotateCalls, typeof rotated !== "string" && rotated.ok && now.includes(rotated.secret)], [true, 1, true]);
    is(`${name}: the endpoint added, tried once, the secret handed out is the one saved`,
      [typeof another === "string" ? another : another.ok, addCalls, typeof another !== "string" && another.ok && now.includes(another.secret)], [true, 1, true]);
    const landedId = (await webhooksView(store)).endpoints.find((e) => e.where.endsWith("/landed"))?.id ?? "";
    casLanded = { value };
    const removed = await outcome(removeEndpoint(store, landedId));
    casLanded = null;
    is(`${name}: removing it is told done, and it is gone`,
      [typeof removed === "string" ? removed : removed.endpoints.some((e) => e.id === landedId), (await webhooksView(store)).endpoints.some((e) => e.id === landedId)], [false, false]);
  }

  part("Settings: when the read back is unknown too, or finds another change, it stays unsure");
  for (const [name, landed, back, other] of [
    ["the read back as a number", { value: "1" }, { value: 42 }, false],
    ["the read back as a list", { value: FAILS }, { value: ["x"] }, false],
    ["another change landed right after", { value: "1" }, null, true],
  ] as [string, { value: unknown }, { value: unknown } | null, boolean][]) {
    casLanded = landed;
    readBack = back;
    readBackArmed = false;
    meanwhile = other ? async () => real([["SET", cfg, JSON.stringify({ ...JSON.parse(String(await settings())), since: 7 })]]) : null;
    casCalls = 0;
    const rotated = await outcome(rotateSecret(store, endpointId));
    const calls = casCalls;
    casLanded = null;
    readBack = null;
    meanwhile = null;
    is(`${name}: unknown, tried once, no secret handed out`, [typeof rotated === "string" ? rotated : "a secret", calls], ["unknown", 1]);
  }

  part("Settings: text that is not settings is unknown, never \"no settings\", and nothing is written over it");
  const kept = await settings();
  await real([["SET", cfg, "{not json"]]);
  casCalls = 0;
  const overRotate = await outcome(rotateSecret(store, endpointId));
  const overAdd = await outcome(addEndpoint(store, "https://hooks.example.com/over", ["sale.completed"]));
  is("replacing the secret and adding an endpoint both say unknown, nothing run", [overRotate, overAdd, casCalls], ["unknown", "unknown", 0]);
  is("the text is as it was", await settings(), "{not json");
  await real([["SET", cfg, String(kept)]]);

  part("Settings, through the studio route: the existing error, no secret in the answer");
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const ask = (body: Record<string, unknown>) => studioRoute(new NextRequest(`${ORIGIN}/api/store/webhooks?store=${store.sid}`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  casReply = { value: "1" };
  const res = await ask({ action: "rotate", id: endpointId });
  casReply = null;
  const answer = (await res.json()) as { ok?: boolean; error?: string; secret?: string };
  is("rotate over an off-shape reply that did not land answers 500 server_error (nothing was changed), no secret", [res.status, answer.ok, answer.error, "secret" in answer], [500, false, "server_error", false]);
  casLanded = { value: "1" };
  const landedRes = await ask({ action: "rotate", id: endpointId });
  casLanded = null;
  const landedAnswer = (await landedRes.json()) as { ok?: boolean; secret?: string };
  is("rotate over an off-shape reply that landed answers the new secret, the one saved",
    [landedRes.status, landedAnswer.ok, typeof landedAnswer.secret === "string" && String(await settings()).includes(landedAnswer.secret)], [200, true, true]);
  casLanded = { value: "1" };
  readBack = { value: 42 };
  readBackArmed = false;
  const unsureRes = await ask({ action: "rotate", id: endpointId });
  casLanded = null;
  readBack = null;
  const unsureAnswer = (await unsureRes.json()) as { ok?: boolean; error?: string; message?: string; secret?: string };
  is("rotate that stays unsure answers 503 unsure, no secret, and says it may have been saved",
    [unsureRes.status, unsureAnswer.ok, unsureAnswer.error, "secret" in unsureAnswer, unsureAnswer.message],
    [503, false, "unsure", false, "We could not confirm whether that change was saved. Reload the page to see your endpoints before you try again."]);

  part("Settings, through the API: a write that landed is answered as done; one that stays unsure never says nothing was changed");
  const writer = await makeKey(store.sid, "Cas writer", Date.now(), true, "none", makerFor(store.sid, "owner", OWNER, true));
  if (!writer.ok) throw new Error("setup: key not made");
  const api = (method: "POST" | "DELETE", body: Record<string, unknown>) =>
    (method === "POST" ? apiAdd : apiRemove)(new Request(`${ORIGIN}/api/v1/hooks`, { method, headers: { authorization: `Bearer ${writer.key}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  type ApiAnswer = { data?: { id?: string; secret?: string; status?: string }; error?: string; message?: string };
  casLanded = { value: "1" };
  const apiAdded = await api("POST", { url: "https://hooks.example.com/api-landed", events: ["sale.completed"] });
  casLanded = null;
  const apiAddedBody = (await apiAdded.json()) as ApiAnswer;
  is("POST that landed with an off-shape reply: 200, its id and the secret saved",
    [apiAdded.status, typeof apiAddedBody.data?.secret === "string" && String(await settings()).includes(apiAddedBody.data.secret)], [200, true]);
  casLanded = { value: "1" };
  const apiRemoved = await api("DELETE", { id: apiAddedBody.data?.id ?? "" });
  casLanded = null;
  const apiRemovedBody = (await apiRemoved.json()) as ApiAnswer;
  is("DELETE that landed with an off-shape reply: 200 removed", [apiRemoved.status, apiRemovedBody.data?.status], [200, "removed"]);
  casLanded = { value: "1" };
  readBack = { value: 42 };
  readBackArmed = false;
  const apiUnsure = await api("POST", { url: "https://hooks.example.com/api-unsure", events: ["sale.completed"] });
  casLanded = null;
  readBack = null;
  const apiUnsureBody = (await apiUnsure.json()) as ApiAnswer;
  is("POST that stays unsure: 502, no secret, says it may have been added",
    [apiUnsure.status, apiUnsureBody.data, apiUnsureBody.message],
    [502, undefined, "The endpoint may have been added, but this could not be confirmed. Check the store's Webhooks page in the studio before adding it again."]);
  const unsureId = (await webhooksView(store)).endpoints.find((e) => e.where.endsWith("/api-unsure"))?.id ?? "";
  casLanded = { value: "1" };
  readBack = { value: 42 };
  readBackArmed = false;
  const apiUnsureGone = await api("DELETE", { id: unsureId });
  casLanded = null;
  readBack = null;
  const apiUnsureGoneBody = (await apiUnsureGone.json()) as ApiAnswer;
  is("DELETE that stays unsure: 502, says it may have been removed",
    [apiUnsureGone.status, apiUnsureGoneBody.message],
    [502, "The endpoint may have been removed, but this could not be confirmed. Check the store's Webhooks page in the studio before trying again."]);

  part("Settings controls: the exact replies behave as before");
  for (const [name, value] of [["[-1]", [-1]], ["[-1, 12]", [-1, 12]]] as [string, unknown][]) {
    const before = await settings();
    casReply = { value };
    casCalls = 0;
    const rotated = await outcome(rotateSecret(store, endpointId));
    const calls = casCalls;
    casReply = null;
    is(`${name}: the text changed meanwhile, so it is made again from a fresh read, then refused`, [rotated, calls], ["threw: The webhook settings kept changing while being saved.", 4]);
    is(`${name}: the settings are as they were`, (await settings()) === before, true);
  }
  const beforeRotate = await settings();
  const rotated = await rotateSecret(store, endpointId);
  is("exact 1 (the real script): the secret is replaced and saved", [rotated.ok, (await settings()) !== beforeRotate, rotated.ok && String(await settings()).includes(rotated.secret)], [true, true, true]);

  part("Resend: a mark reply in any other shape is unknown: nothing sent, nothing taken, could not be sent just now");
  for (const [name, value] of OFF_SHAPES) {
    const sentBefore = sends;
    const usedBefore = await allowanceUsed(store, "webhook");
    const logBefore = (await webhooksView(store)).log.length;
    const ttlBefore = await ttlOf(original);
    casReply = { value };
    const again = brief(await outcome(resendDelivery(store, failedId)));
    casReply = null;
    is(`${name}: could not be sent just now`, again, "unavailable");
    is(`${name}: nothing sent, nothing taken, no line written, the original unmarked`,
      [sends - sentBefore, (await allowanceUsed(store, "webhook")) - usedBefore, (await webhooksView(store)).log.length - logBefore, (await real([["GET", original]]))[0] === failedRaw],
      [0, 0, 0, true]);
    const ttl = await ttlOf(original);
    is(`${name}: the original keeps an expiry, never longer than it had`, ttl > 0 && ttl <= ttlBefore, true);
  }

  part("Resend: a mark that landed with a reply in another shape, or a call that failed after it, keeps the original's expiry");
  for (const [name, value] of UNKNOWN) {
    const sentBefore = sends;
    const usedBefore = await allowanceUsed(store, "webhook");
    const ttlBefore = await ttlOf(original);
    casLanded = { value };
    const again = brief(await outcome(resendDelivery(store, failedId)));
    casLanded = null;
    is(`${name}: not sent, nothing taken`, [value === FAILS ? again.startsWith("threw: ") : again, sends - sentBefore, (await allowanceUsed(store, "webhook")) - usedBefore], [value === FAILS ? true : "unavailable", 0, 0]);
    const ttl = await ttlOf(original);
    is(`${name}: the original still expires, never later than it would have (${ttl} ms)`, ttl > 0 && ttl <= ttlBefore, true);
    await real([["SET", original, String(failedRaw), "EX", 3600]]);
  }

  part("The in-memory script clears the key's expiry, as real Redis's SET does");
  await real([["SET", "nl:test:cas-ttl", "a", "EX", 100]]);
  is("the script writes over the text read", (await real([["EVAL", SAVE_CRM_PIPELINES, 1, "nl:test:cas-ttl", "a", "b"]]))[0], 1);
  is("and the key keeps no expiry", await ttlOf("nl:test:cas-ttl"), -1);

  part("Resend: the delivery and its time left are read exactly, before anything is marked");
  for (const [name, at, value] of [["the delivery as a number", 0, 42], ["the delivery as a list", 0, ["x"]], ["its time left as text", 1, "5000"], ["its time left as null", 1, null], ["its time left as 1.5", 1, 1.5]] as [string, number, unknown][]) {
    const sentBefore = sends;
    casCalls = 0;
    bend = (c, reply) => {
      if (at === 0 && c[0] === "GET" && c[1] === original) return value;
      if (at === 1 && c[0] === "PTTL" && c[1] === original) return value;
      return reply;
    };
    const again = brief(await outcome(resendDelivery(store, failedId)));
    bend = null;
    is(`${name}: could not be sent just now, nothing marked or sent`, [again, casCalls, sends - sentBefore], ["unavailable", 0, 0]);
  }

  part("Resend control: exact [-1] and [-1, n] are told it was sent again, as before");
  for (const value of [[-1], [-1, 300]]) {
    casReply = { value };
    const again = brief(await outcome(resendDelivery(store, failedId)));
    casReply = null;
    is(`${JSON.stringify(value)}: resent`, again, "resent");
  }

  part("Resend control: exact 1 (the real script) marks the original and sends once");
  const sentBefore = sends;
  const sent = await outcome(resendDelivery(store, failedId));
  const first = typeof sent === "string" ? null : sent;
  is("tried once, a new line naming the original", [first?.ok, sends - sentBefore, first?.ok ? first.delivery.resentFrom : null], [true, 1, failedId]);
  const resentAs = first?.ok ? first.delivery.id : "";

  part("Resend: the last resend is read exactly; one in another shape is unknown, never taken as gone");
  for (const [name, value] of [["a number", 7], ["a list", ["x"]], ["text that is not a delivery", "{not json"]] as [string, unknown][]) {
    const before = sends;
    casCalls = 0;
    bend = (c, reply) => (c[0] === "GET" && c[1] === `nl:hooks:d:${resentAs}` ? value : reply);
    const again = brief(await outcome(resendDelivery(store, failedId)));
    bend = null;
    is(`${name}: could not be sent just now, nothing marked or sent`, [again, casCalls, sends - before], ["unavailable", 0, 0]);
  }
  const [gone] = await real([["DEL", `nl:hooks:d:${resentAs}`]]);
  is("setup: the last resend expired", gone, 1);
  const afterGone = sends;
  const again = brief(await outcome(resendDelivery(store, failedId)));
  is("control: a last resend that is gone (null) lets the original be sent again", [again, sends - afterGone], ["sent", 1]);

  done();
}
void main();
