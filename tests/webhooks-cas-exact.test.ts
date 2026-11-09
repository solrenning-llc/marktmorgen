/**
 * The webhook settings' compare-and-set and the resend's mark read the script's reply only in its exact shape
 * (lib/webhooks.ts changeConfig and resendDelivery; CX-123 rules 24 and 30).
 *
 * The script (SAVE_CRM_PIPELINES v2 in lib/crm.ts, modelled by lib/redis-memory.ts) answers 1 when it wrote, and
 * [-1] or [-1, n] when the text there was not the one read. Any other reply is unknown: nothing is said saved or
 * marked, a settings change is not made again over it (it may have landed) and answers the existing error, and a
 * resend sends nothing and answers that it could not be sent just now. The reads beside the resend's mark (the
 * delivery with its time left, and the last resend) are exact too.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts); no request leaves (the address resolver refuses).
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as studioRoute } from "@/app/api/store/webhooks/route";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { addEndpoint, emitEvent, resendDelivery, rotateSecret, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
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
const isCas = (c: Command) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-pipelines-save:v2\n");
/** While set, a compare-and-set is not run: this is its reply. */
let casReply: { value: unknown } | null = null;
let casCalls = 0;
/** While set, the reply to each other command it matches is replaced by what it returns (the command still runs). */
let bend: ((command: Command, reply: unknown) => unknown) | null = null;
redis.pipeline = (async (commands: Command[]) => {
  // The queue's lease is not taken here, so the event's first try waits (no network either way).
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) return [0];
  if (commands.length === 1 && isCas(commands[0])) {
    casCalls += 1;
    if (casReply) return [casReply.value];
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

  part("Settings: a compare-and-set reply in any other shape is unknown, never saved, never made again over it");
  for (const [name, value] of OFF_SHAPES) {
    const before = await settings();
    casReply = { value };
    casCalls = 0;
    const rotated = await outcome(rotateSecret(store, endpointId));
    const rotateCalls = casCalls;
    casCalls = 0;
    const another = await outcome(addEndpoint(store, "https://hooks.example.com/another", ["sale.completed"]));
    const addCalls = casCalls;
    casReply = null;
    is(`${name}: replacing the secret says unknown, tried once, no secret handed out`, [typeof rotated === "string" ? rotated : "a secret", rotateCalls], ["unknown", 1]);
    is(`${name}: adding an endpoint says unknown, tried once, no secret handed out`, [typeof another === "string" ? another : "a secret", addCalls], ["unknown", 1]);
    is(`${name}: the settings are as they were`, (await settings()) === before, true);
  }

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
  is("rotate over an off-shape reply answers 500 server_error, no secret", [res.status, answer.ok, answer.error, "secret" in answer], [500, false, "server_error", false]);

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
    casReply = { value };
    const again = brief(await outcome(resendDelivery(store, failedId)));
    casReply = null;
    is(`${name}: could not be sent just now`, again, "unavailable");
    is(`${name}: nothing sent, nothing taken, no line written, the original unmarked`,
      [sends - sentBefore, (await allowanceUsed(store, "webhook")) - usedBefore, (await webhooksView(store)).log.length - logBefore, (await real([["GET", original]]))[0] === failedRaw],
      [0, 0, 0, true]);
  }

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
