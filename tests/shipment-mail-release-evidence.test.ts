/** CX-121 orchestration/UI evidence. The imported fixture is explicitly an
 * ACK stand-in; real Lua/counter evidence lives in the companion Python test.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkShipped } from "@/components/mark-shipped";
import { markShipped, doneKey } from "@/lib/shipments";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { enqueueShipmentMail, runShipmentMail, shipmentMailStatus, shipmentMailOf, forgetShipmentMail } from "@/lib/shipment-mail-outbox";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const now = 1800000000000;
  const input = { statsId: "synthetic_release", session: "cs_test_shipmentrelease00001", authorizedAt: now,
    shipped: { at: now / 1000, tracking: "" }, message: { from: "Synthetic store <mail@example.test>", to: "buyer@example.test", subject: "Synthetic shipment", text: "Synthetic shipping update", replyTo: "owner@example.test" } };
  part("A confirmed provider refusal is terminal for protected message content");
  store.clear();
  const world = shipmentOutboxFixture();
  const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(now), pipeline: world.pipeline, now: () => now };
  is("synthetic queue input was acknowledged", (await enqueueShipmentMail(input, runtime)).ok, true);
  const create = world.commands.find(command => command[0] === "EVAL")!;
  let posts = 0;
  await runShipmentMail(now + 20000, async (_message, beforePost) => { if (!await beforePost()) return "unknown"; posts++; return "refused"; }, runtime);
  is("the provider was attempted only once after its barrier", posts, 1);
  is("the refusal remains distinct from acceptance", (await shipmentMailStatus(input.statsId, input.session, runtime))?.state, "refused");
  const raw = store.run(["GET", String(create[3])]);
  is("a terminal refusal no longer retains the sealed message", typeof raw !== "string" || !JSON.parse(raw).sealed, true);
  is("a matching source starts its existing 400-day terminal retention", store.run(["TTL", String(create[4])]), 400 * 86400);
  await runShipmentMail(now + 20000, async () => { posts++; return "accepted"; }, runtime);
  is("a refusal is not automatically retried", posts, 1);
  is("the personal copy keeps only the minimal refused status", await shipmentMailOf(input.statsId, input.message.to, runtime), [{ checkout: input.session, state: "refused", at: now }]);
  await forgetShipmentMail(input.statsId, input.message.to, runtime);
  is("person erasure removes the terminal status", await shipmentMailStatus(input.statsId, input.session, runtime), { state: "not_recorded", delayed: false });

  part("An explicit no-POST outcome retains custody and its existing retry budget");
  for (const stage of ["before", "confirmed", "lost", "slow"] as const) {
    store.clear();
    const noPostWorld = shipmentOutboxFixture();
    let clock = now;
    const noPostRuntime = { ...runtime, now: () => clock, pipeline: async (commands: (string | number)[][]) => {
      const answer = await noPostWorld.pipeline(commands);
      if (stage === "slow" && commands.some(command => command[0] === "EVAL" && command[13] === "dispatch")) clock = now + 21000;
      return answer;
    } };
    const noPostInput = { ...input, statsId: `synthetic_no_post_${stage}`, session: `cs_test_shipmentnopost${stage}01` };
    await enqueueShipmentMail(noPostInput, noPostRuntime);
    const created = noPostWorld.commands.find(command => command[0] === "EVAL")!;
    if (stage === "lost") noPostWorld.loseNext("dispatch");
    const result = await runShipmentMail(now + 20000, async (_message, beforePost) => {
      if (stage !== "before") {
        const permission = await beforePost();
        if (stage === "slow") is("a dispatch acknowledgment after the worker deadline grants no POST", permission, false);
      }
      return "not_posted";
    }, noPostRuntime);
    is(`${stage}: explicit no POST returns to known waiting`, result, { accepted: 0, waiting: 1, unknown: 0 });
    is(`${stage}: the same source remains queued`, (await shipmentMailStatus(noPostInput.statsId, noPostInput.session, noPostRuntime))?.state, "queued");
    const raw = store.run(["GET", String(created[3])]);
    const kept = typeof raw === "string" ? JSON.parse(raw) : null;
    is(`${stage}: no-POST custody keeps its sealed content`, typeof kept?.sealed, "string");
    is(`${stage}: the original check was charged and never reset`, kept?.checks, 1);
  }

  part("Incomplete receipts and unrecognized provider outcomes stay unknown");
  for (const scenario of ["no-post-short", "no-post-bad-row", "no-post-extra", "no-post-checks", "no-post-schedule", "no-post-owner", "claim-extra", "dispatch-extra", "accepted-extra"]) {
    store.clear();
    const ackWorld = shipmentOutboxFixture();
    const ackInput = { ...input, statsId: "synthetic_ack", session: "cs_test_ack" + scenario.replaceAll("-", "") + "0001" };
    const target = scenario.startsWith("no-post") ? "not-posted" : scenario.split("-")[0];
    const ackRuntime = { ...runtime, pipeline: async (commands: (string | number)[][]) => {
      const reply = await ackWorld.pipeline(commands);
      if (!commands.some(command => command[0] === "EVAL" && command[13] === target)) return reply;
      const original = reply[0] as unknown[];
      if (scenario === "no-post-short") return [["queued"]];
      if (scenario === "no-post-bad-row") return [["queued", "not JSON"]];
      if (["no-post-checks", "no-post-schedule", "no-post-owner"].includes(scenario)) {
        const row = JSON.parse(String(original[1]));
        if (scenario === "no-post-checks") row.checks = 0;
        if (scenario === "no-post-schedule") row.next = 0;
        if (scenario === "no-post-owner") row.owner = "a".repeat(48);
        return [["queued", JSON.stringify(row)]];
      }
      return [[...original, "unexpected"]];
    } };
    await enqueueShipmentMail(ackInput, ackRuntime);
    let called = 0, permitted = 0;
    const answer = await runShipmentMail(now + 20000, async (_message, beforePost) => {
      called++;
      const allowed = await beforePost();
      if (allowed) permitted++;
      return scenario === "accepted-extra" && allowed ? "accepted" : "not_posted";
    }, ackRuntime);
    if (scenario === "dispatch-extra") is("an extra dispatch slot never grants a POST", permitted, 0);
    else {
      if (scenario === "claim-extra") is("an extra claim slot never starts the sender", called, 0);
      is(`${scenario}: incomplete or changed evidence cannot confirm completion`, answer, { accepted: 0, waiting: 0, unknown: 1 });
    }
  }
  for (const received of [null, undefined, false, 0, { kind: "accepted" }, "unrecognized"]) {
    store.clear();
    const unknownWorld = shipmentOutboxFixture();
    const unknownRuntime = { ...runtime, pipeline: unknownWorld.pipeline };
    const unknownInput = { ...input, statsId: "synthetic_unknown", session: "cs_test_unknownresult0001" };
    await enqueueShipmentMail(unknownInput, unknownRuntime);
    const created = unknownWorld.commands.find(command => command[0] === "EVAL")!;
    await runShipmentMail(now + 20000, async (_message, beforePost) => { await beforePost(); return received as never; }, unknownRuntime);
    is("an unrecognized sender outcome retains protected custody", typeof store.run(["GET", String(created[3])]), "string");
    is("an unrecognized sender outcome is never recorded as refusal", (await shipmentMailStatus(unknownInput.statsId, unknownInput.session, unknownRuntime))?.state, "acceptance_unknown");
  }
  const fullAck = await enqueueShipmentMail({ ...input, statsId: "synthetic_full_ack", session: "cs_test_fullackunknown001" }, { ...runtime, pipeline: async () => [["full", "unexpected"]] });
  is("a noncanonical full receipt is unknown", fullAck, { ok: false, reason: "unknown" });

  part("The server-rendered mark must not invent missing mail evidence");
  const html = renderToStaticMarkup(createElement(MarkShipped, { session: input.session, to: null, shipped: input.shipped }));
  is("until a server status confirms it, missing acceptance is not asserted", html.includes("acceptance was not recorded"), false);
  const status = html.match(/<p\b[^>]*role="status"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
  is("the shipment status region excludes the email detail line", /acceptance|email/i.test(status), false);
  part("Real fulfillment remains possible when protected mail cannot be retained");
  store.clear();
  const owner = "shipment-release@example.test";
  await claimHandle(owner, "releaseevidence", "Synthetic release", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_NRelease01");
  const creator = (await storeForEmail(owner))!;
  const priorFetch = globalThis.fetch, priorKey = process.env.STRIPE_SECRET_KEY;
  const originalPipeline = store.pipeline;
  process.env.STRIPE_SECRET_KEY = "sk_test_shipping_only_a_stand_in";
  let recipient: unknown = "buyer@example.test", providerReads = 0;
  globalThis.fetch = (async (url, init) => {
    const request = new URL(String(url));
    if (request.hostname !== "api.stripe.com" || (init?.method ?? "GET") !== "GET") throw Error("No external or sending request allowed");
    providerReads++;
    return new Response(JSON.stringify({ id: input.session, status: "complete", payment_status: "paid", metadata: { store: creator.handle, ship: "yes" }, customer_details: { email: recipient } }));
  }) as typeof fetch;
  try {
    const fullRuntime = { ...runtime, pipeline: async (commands: (string | number)[][]) => commands.map(command => command[0] === "EVAL" ? ["full"] : null) };
    const full = await markShipped(creator, input.session, "", now / 1000, fullRuntime);
    is("a full mail pool does not prevent marking the paid order shipped", full.ok, true);
    is("a full mail pool explicitly reports no recorded email", full.ok ? full.mail : null, { state: "not_recorded", delayed: false });
    store.run(["DEL", doneKey(input.session)]);
    recipient = null;
    const winner = { at: now / 1000 - 1, tracking: "https://example.test/winning-tracking" };
    store.pipeline = async commands => {
      if (commands.some(command => command[0] === "SET" && command[1] === doneKey(input.session))) {
        store.run(["SET", doneKey(input.session), JSON.stringify(winner), "EX", 400 * 86400]);
      }
      return originalPipeline(commands);
    };
    const raced = await markShipped(creator, input.session, "https://example.test/losing-tracking", now / 1000, runtime);
    is("a simultaneous marker returns the real winning shipment", raced.ok ? raced.shipped : null, winner);
    is("re-reading the winning mark never submits a provider message", [raced.ok && raced.emailed, providerReads], [false, 2]);
  } finally {
    globalThis.fetch = priorFetch;
    store.pipeline = originalPipeline;
    if (priorKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = priorKey;
  }
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
