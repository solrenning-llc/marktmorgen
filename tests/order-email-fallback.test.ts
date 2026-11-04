import { performance } from "node:perf_hooks";
import { done, is, part } from "./check";
import { createResendFallbackFixture } from "./resend-fallback-fixture";
import { guardedResendPost, type ResendPost } from "../lib/resend-fallback-transport";
import { sendEmail, sendBatch, queuedShipmentMailSender } from "@/lib/email";
import { enqueueShipmentMail, runShipmentMail, shipmentMailStatus } from "@/lib/shipment-mail-outbox";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { store } from "./redis-stub";

const credential = "re_SYNTHETIC_TRANSPORT_ONLY";
const message = { from: "Store <owner@example.test>", to: ["buyer@example.test"], subject: "An existing right", text: "The original content" };
const request = (key: string, extra: Partial<ResendPost> = {}): ResendPost => ({
  base: "https://api.resend.com", path: "/emails", credential, usageCredential: credential,
  body: JSON.stringify(message), recipients: 1, idempotencyKey: key, ...extra,
});
const reply: typeof fetch = async (_input, init) => {
  const body: unknown = JSON.parse(String(init?.body));
  return Response.json(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `synthetic_${i}` })) } : { id: "synthetic_message" });
};
async function main() {
  store.clear();
  part("The real transport remains closed without account proof");
  let forbidden = 0;
  is("default review and credential binding grant no route", await guardedResendPost(request("closed"), { fetch: async () => { forbidden++; throw Error("No external I/O"); } }), { kind: "blocked" });
  is("closed defaults do not read usage or post", forbidden, 0);
  const full = await createResendFallbackFixture({ credential, sent: 49_998, received: 1, fetch: reply });
  is("the final included slot can be accepted", (await guardedResendPost(request("last-slot"), full.runtime)).kind, "response");
  is("replay reads exact accepted provenance without another provider POST", (await guardedResendPost(request("last-slot"), full.runtime)).kind, "accepted_receipt");
  is("entry and exit share the same 50000-email quota", (await guardedResendPost(request("over-limit"), full.runtime)).kind, "blocked");
  is("full quota makes exactly one HTTP POST", full.requests.filter(r => r.method === "POST").length, 1);
  const before = full.requests.length;
  is("a foreign sending key cannot borrow this account", (await guardedResendPost(request("foreign", { credential: "re_OTHER_SYNTHETIC" }), full.runtime)).kind, "blocked");
  is("a foreign usage key cannot borrow this account", (await guardedResendPost(request("foreign-usage", { usageCredential: "re_OTHER_SYNTHETIC" }), full.runtime)).kind, "blocked");
  is("credential mismatches never make a provider call", full.requests.length, before);
  is("body recipients cannot be undercounted", (await guardedResendPost(request("underreported", { body: JSON.stringify({ ...message, to: ["one@example.test", "two@example.test"] }) }), full.runtime)).kind, "blocked");
  is("hidden additional recipients cannot bypass admission", (await guardedResendPost(request("bcc", { body: JSON.stringify({ ...message, bcc: ["extra@example.test"] }) }), full.runtime)).kind, "blocked");
  const equalIntentions = await createResendFallbackFixture({ credential, fetch: reply });
  await guardedResendPost(request("unused", { idempotencyKey: undefined }), equalIntentions.runtime);
  await guardedResendPost(request("unused", { idempotencyKey: undefined }), equalIntentions.runtime);
  is("identical intentional calls without a stable key are separate attempts", equalIntentions.requests.filter(r => r.method === "POST").length, 2);
  const attachment = Buffer.alloc(12_000_000, 1).toString("base64");
  const large = await createResendFallbackFixture({ credential, fetch: reply });
  is("an existing 12 MB attachment survives its 16 MB base64 envelope", (await guardedResendPost(request("large-forward", { body: JSON.stringify({ ...message, attachments: [{ filename: "synthetic.bin", content: attachment }] }) }), large.runtime)).kind, "response");

  part("Concurrent account-wide admission and ACK uncertainty");
  const parallel = await createResendFallbackFixture({ credential, cap: 1, fetch: reply });
  const outcomes = await Promise.all(Array.from({ length: 64 }, (_, i) => guardedResendPost(request(`parallel-${i}`), parallel.runtime)));
  is("64 distinct senders can consume only one slot", outcomes.filter(r => r.kind === "response").length, 1);
  is("one dispatch receipt permits only one POST", parallel.requests.filter(r => r.method === "POST").length, 1);
  const lost = await createResendFallbackFixture({ credential, cap: 1, fetch: reply });
  lost.loseNext("dispatch");
  is("lost dispatch ACK is unknown", (await guardedResendPost(request("lost-dispatch"), lost.runtime)).kind, "unknown");
  await guardedResendPost(request("lost-dispatch"), lost.runtime);
  is("a possibly committed dispatch is never repeated", [lost.requests.filter(r => r.method === "POST").length, lost.held()], [0, 1]);
  const uncertain = await createResendFallbackFixture({ credential, fetch: async () => { throw Error("Reply lost after possible acceptance"); } });
  is("an HTTP transport failure is unknown", (await guardedResendPost(request("lost-http"), uncertain.runtime)).kind, "unknown");
  await guardedResendPost(request("lost-http"), uncertain.runtime);
  is("unknown response conserves its reservation and cannot POST twice", [uncertain.requests.filter(r => r.method === "POST").length, uncertain.held()], [1, 1]);
  const malformed = await createResendFallbackFixture({ credential, fetch: async () => Response.json({ ok: true }) });
  is("HTTP success without a provider ID is not acceptance", (await guardedResendPost(request("missing-id"), malformed.runtime)).kind, "unknown");
  is("missing acceptance proof retains the slot", malformed.held(), 1);
  const lostSettlement = await createResendFallbackFixture({ credential, fetch: reply });
  lostSettlement.loseNext("settle");
  is("lost settlement ACK is reconciled with its owned receipt", (await guardedResendPost(request("lost-settlement"), lostSettlement.runtime)).kind, "response");
  is("settlement reconciliation never repeats HTTP", lostSettlement.requests.filter(r => r.method === "POST").length, 1);
  let attempts = 0;
  const refused = await createResendFallbackFixture({ credential, cap: 1, fetch: async (...args) => ++attempts === 1 ? Response.json({ message: "rate limited" }, { status: 429 }) : reply(...args) });
  is("a known rejection reaches the caller", (await guardedResendPost(request("known-no"), refused.runtime)).kind, "response");
  is("known non-acceptance releases only its own slot", refused.held(), 0);
  is("known non-acceptance may rearm the same immutable attempt", (await guardedResendPost(request("known-no"), refused.runtime)).kind, "response");
  const blocked = await createResendFallbackFixture({ credential, fetch: reply });
  await guardedResendPost(request("failed-barrier", { beforePost: async () => false }), blocked.runtime);
  is("a refused local barrier settles only its own dispatched hold without HTTP", [blocked.requests.filter(r => r.method === "POST").length, blocked.held()], [0, 0]);
  let releasePost!: () => void, enteredPost!: () => void, refusalCalls = 0;
  const postHeld = new Promise<void>(resolve => { releasePost = resolve; });
  const postEntered = new Promise<void>(resolve => { enteredPost = resolve; });
  const race = await createResendFallbackFixture({ credential, cap: 1, fetch: async (...args) => { enteredPost(); await postHeld; return reply(...args); } });
  const first = guardedResendPost(request("shared-token", { beforePost: async () => true }), race.runtime);
  await postEntered;
  await guardedResendPost(request("shared-token", { beforePost: async () => { refusalCalls++; return false; } }), race.runtime);
  is("a losing concurrent invocation never executes its local barrier", refusalCalls, 0);
  is("a concurrent local refusal preserves an in-flight account hold", race.held(), 1);
  is("no extra message fits while the original POST is in flight", (await guardedResendPost(request("extra-in-flight"), race.runtime)).kind, "blocked");
  releasePost();
  is("the original provider acceptance can settle its unchanged hold", (await first).kind, "response");
  is("the race never admits a second POST above quota", race.requests.filter(r => r.method === "POST").length, 1);
  const deadline = await createResendFallbackFixture({ credential, fetch: reply });
  const originalClock = Date.now, basePipeline = deadline.runtime.pipeline!;
  deadline.runtime.pipeline = async commands => {
    const result = await basePipeline(commands);
    if (commands[0]?.[5] === "dispatch") {
      const late = originalClock() + 1_001;
      Date.now = () => late;
    }
    return result;
  };
  try {
    is("a dispatch receipt which expired during an await cannot POST", (await guardedResendPost(request("expired-dispatch"), deadline.runtime)).kind, "unknown");
    is("the last clock check is immediately before the provider call", deadline.requests.filter(r => r.method === "POST").length, 0);
  } finally { Date.now = originalClock; }

  part("The transport checks the monotonic deadline after the helper returns");
  const monotonic = await createResendFallbackFixture({ credential, fetch: reply });
  const performanceDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
  let clockReads = 0;
  // Start before RPC, valid helper return, then scheduling work consumes the
  // remaining window before the transport's own final check. UTC stays valid.
  const samples = [100, 101, 1_101];
  const utcAt = Date.now();
  Date.now = () => utcAt;
  try {
    Object.defineProperty(performance, "now", { configurable: true, value: () => samples[Math.min(clockReads++, samples.length - 1)] });
    is("consumer work after a valid budget helper cannot POST past its monotonic deadline", (await guardedResendPost(request("late-consumer"), monotonic.runtime)).kind, "unknown");
    is("the final transport check preserved the hold without HTTP", [clockReads, monotonic.requests.filter(r => r.method === "POST").length, monotonic.held()], [3, 0, 1]);
  } finally {
    Date.now = originalClock;
    if (performanceDescriptor) Object.defineProperty(performance, "now", performanceDescriptor);
    else Reflect.deleteProperty(performance, "now");
  }

  part("Real email entry points use the same reviewed transport");
  process.env.RESEND_API_KEY = credential;
  for (const key of ["AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "VERCEL_OIDC_TOKEN"]) delete process.env[key];
  const entry = await createResendFallbackFixture({ credential, cap: 3, fetch: reply });
  is("single service entry has a guarded positive control", await sendEmail({ meter: { by: "company" }, from: message.from, to: message.to[0], subject: message.subject, text: message.text }, entry.runtime), true);
  is("batch shares the account and counts every recipient", await sendBatch([{ ...message, to: message.to[0], html: "<p>The original content</p>" }, { ...message, to: "second@example.test", html: "<p>The original content</p>" }], "synthetic-real-batch", { by: "company" }, "resend", entry.runtime), "sent");
  is("the next single service attempt cannot exceed the shared account", await sendEmail({ meter: { by: "company" }, from: message.from, to: message.to[0], subject: "Over quota", text: message.text }, entry.runtime), false);
  is("only the admitted single and batch were posted", entry.requests.filter(r => r.method === "POST").length, 2);

  part("A dedicated full-access usage key is independent of the sending key");
  const fullAccess = "re_SYNTHETIC_FULL_ACCESS_USAGE_ONLY";
  process.env.RESEND_READ_API_KEY = fullAccess;
  const dedicated = await createResendFallbackFixture({ credential, usageCredential: fullAccess, fetch: reply });
  is("a restricted sending key uses the dedicated account usage credential", await sendEmail({ meter: { by: "company" }, from: message.from, to: message.to[0], subject: message.subject, text: message.text }, dedicated.runtime), true);
  is("batch uses the same dedicated usage credential", await sendBatch([{ ...message, to: message.to[0], html: "<p>The original content</p>" }], "synthetic-dedicated-usage", { by: "company" }, "resend", dedicated.runtime), "sent");
  is("durable shipment fallback uses the dedicated usage credential", await queuedShipmentMailSender(dedicated.runtime)({ ...message, to: message.to[0], replyTo: "owner@example.test" }, async () => true, { id: "synthetic_dedicated_usage_shipment" }), "accepted");
  is("all three real entry points made reviewed usage reads and provider POSTs", [dedicated.requests.filter(r => r.method === "GET").length, dedicated.requests.filter(r => r.method === "POST").length], [3, 3]);
  delete process.env.RESEND_READ_API_KEY;

  part("A real shipment waits durably above fallback quota");
  process.env.NIMBUS_DATA_KEY = "SYNTHETIC_SHIPMENT_DATA_KEY_1234567890";
  const now = Date.now(), queue = shipmentOutboxFixture();
  const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(now), pipeline: queue.pipeline, now: () => now };
  const work = { statsId: "synthetic_fallback_store", session: "cs_test_fallbackshipment00001", authorizedAt: now,
    shipped: { at: Math.floor(now / 1000), tracking: "https://example.test/original" },
    message: { ...message, to: message.to[0], replyTo: "owner@example.test" } };
  await enqueueShipmentMail(work, runtime);
  const exhausted = await createResendFallbackFixture({ credential, cap: 1, sent: 1, fetch: reply });
  const waiting = await runShipmentMail(now + 20_000, queuedShipmentMailSender(exhausted.runtime), runtime);
  is("quota exhaustion reports saved waiting without a POST", [waiting.accepted, waiting.waiting, exhausted.requests.filter(r => r.method === "POST").length], [0, 1, 0]);
  is("the paid order email remains reachable", (await shipmentMailStatus(work.statsId, work.session, runtime))?.state, "queued");
  is("the physical source keeps its pending lifetime", store.run(["TTL", `nl:ship:done:${work.session}`]), -1);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
