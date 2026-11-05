import { done, is, part } from "./check";
import { createHash } from "node:crypto";
import { enqueueShipmentMail, runShipmentMail, shipmentMailId, shipmentMailPolicy, shipmentMailStatus, forgetShipmentMail } from "@/lib/shipment-mail-outbox";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";
import { store } from "./redis-stub";

async function main() {
  store.clear();
  const now = Date.now();
  const priorKey = process.env.NIMBUS_DATA_KEY;
  process.env.NIMBUS_DATA_KEY = "SYNTHETIC_SHIPMENT_DATA_KEY_1234567890";
  const input = {
    statsId: "store_shipment_synthetic", session: "cs_test_shipmentoutbox000001", authorizedAt: now,
    shipped: { at: Math.floor(now / 1000), tracking: "https://example.test/track" },
    message: { from: "A store <mail@example.test>", to: "buyer@example.test", subject: "On its way", text: "Your original tracking: https://example.test/track", replyTo: "owner@example.test" },
  };
  const world = shipmentOutboxFixture();
  const runtime = { lifecycle: "active" as const, policy: shipmentPolicy(now), pipeline: world.pipeline, now: () => now };
  try {
    part("Unknown funding never creates a shipment or pretends to queue");
    is("the actual policy remains absent", await enqueueShipmentMail(input, { pipeline: world.pipeline }), { ok: false, reason: "unknown" });
    is("unknown funding made no storage request", world.commands.length, 0);
    is("never activated cleanup adds no command", await forgetShipmentMail(input.statsId, input.message.to, { pipeline: world.pipeline }), 0);
    is("never activated status adds no command", await shipmentMailStatus(input.statsId, input.session, { pipeline: world.pipeline }), { state: "not_recorded", delayed: false });
    is("the never activated lifecycle made no storage request", world.commands.length, 0);
    is("a policy alone cannot bypass cleanup activation", await enqueueShipmentMail(input, { policy: shipmentPolicy(now), pipeline: world.pipeline }), { ok: false, reason: "unknown" });
    let reads = 0;
    const bad = Object.defineProperty(shipmentPolicy(now), "ongoingStorageFunded", { get() { reads++; return true; } });
    is("executable evidence is refused", shipmentMailPolicy(bad, now), null);
    is("financial getters never execute", reads, 0);
    const executable = { ...shipmentPolicy(now), toJSON() { reads++; return { ...shipmentPolicy(now), globalItems: 1_000_000, maximumChecks: 1_000_000 }; } };
    is("an extra executable serializer is not a reviewed policy", shipmentMailPolicy(executable, now), null);
    is("policy serializers never execute", reads, 0);
    is("expired admissions do not authorize new storage", shipmentMailPolicy({ ...runtime.policy, admissionsUntil: now - 1 }, now), null);
    is("the same funded policy can still drain admitted work", shipmentMailPolicy({ ...runtime.policy, admissionsUntil: now - 1 }, now, false)?.reviewId, runtime.policy.reviewId);
    const identityWorld = shipmentOutboxFixture();
    let identityReads = 0;
    const identityMessage = new Proxy(input.message, { get(target, key, receiver) { identityReads++; return key === "to" ? "wrong@example.test" : Reflect.get(target, key, receiver); } });
    const identityInput = { ...input, session: "cs_test_shipmentoutboxidentity", message: identityMessage };
    is("a validated data snapshot supplies the complete identity", (await enqueueShipmentMail(identityInput, { ...runtime, pipeline: identityWorld.pipeline })).ok, true);
    const identityCreate = identityWorld.commands.find(c => c[0] === "EVAL")!;
    is("the deletion index matches the protected recipient snapshot", JSON.parse(String(identityCreate[15])).person, createHash("sha256").update(input.message.to).digest("hex"));
    is("message get traps never reread identity after validation", identityReads, 0);
    await forgetShipmentMail(input.statsId, input.message.to, { ...runtime, pipeline: identityWorld.pipeline });

    part("An acknowledged immutable payload is protected before dispatch");
    const queued = await enqueueShipmentMail(input, runtime);
    is("queue acknowledgment is explicit and contains no delivery claim", queued, { ok: true, mail: { state: "queued", delayed: false } });
    const create = world.commands.find(c => c[0] === "EVAL")!;
    const raw = String(create[15]);
    is("the stored row contains neither recipient nor message text", [raw.includes(input.message.to), raw.includes(input.message.text)], [false, false]);
    is("pending source and payload have no silent expiry", [store.run(["TTL", String(create[3])]), store.run(["TTL", String(create[4])])], [-1, -1]);
    is("repeat producer keeps the existing queue record", (await enqueueShipmentMail(input, runtime)).ok, true);
    const calls: string[] = [];
    const accepted = await runShipmentMail(now + 20_000, async (letter, barrier) => {
      calls.push("prepare");
      is("the original complete message is recovered", letter, input.message);
      is("provider permission requires an acknowledged barrier", await barrier(), true);
      calls.push("post");
      is("one barrier cannot authorize two POSTs", await barrier(), false);
      return "accepted";
    }, runtime);
    is("one accepted message is recorded", [accepted, calls], [{ accepted: 1, waiting: 0, unknown: 0 }, ["prepare", "post"]]);
    is("accepted payload is removed but the source remains", [store.run(["EXISTS", String(create[3])]), store.run(["EXISTS", String(create[4])])], [0, 1]);
    is("the legacy source never creates another email", (await enqueueShipmentMail(input, runtime)).ok, true);

    part("A lost dispatch ACK does not let the provider be called");
    const uncertain = { ...input, session: "cs_test_shipmentoutbox000002" };
    await enqueueShipmentMail(uncertain, runtime);
    world.loseNext("dispatch");
    let posts = 0;
    const outcome = await runShipmentMail(now + 20_000, async (_letter, barrier) => {
      if (!(await barrier())) return "unknown";
      posts++; return "accepted";
    }, runtime);
    is("unknown barrier never posts or claims acceptance", [posts, outcome.accepted, outcome.unknown], [0, 0, 1]);
    is("the persistent unknown attempt is visible", (await shipmentMailStatus(uncertain.statsId, uncertain.session, runtime))?.state, "acceptance_unknown");
    const later = { ...runtime, now: () => now + 73 * 3_600_000 };
    await runShipmentMail(now + 74 * 3_600_000, async () => { posts++; return "accepted"; }, later);
    is("waiting beyond provider key retention never repeats uncertain work", posts, 0);

    part("Known waiting survives 24 and 72 hours without another checkout read");
    const waiting = { ...input, session: "cs_test_shipmentoutbox000003" };
    await enqueueShipmentMail(waiting, runtime);
    is("no provider attempt remains known waiting", await runShipmentMail(now + 20_000, async () => "waiting", runtime), { accepted: 0, waiting: 1, unknown: 0 });
    is("the delay is explicit", (await shipmentMailStatus(waiting.statsId, waiting.session, later))?.delayed, true);
    const drained = await runShipmentMail(now + 74 * 3_600_000, async (letter, barrier) => {
      is("delayed work uses the immutable original", letter.text, input.message.text);
      return await barrier() ? "accepted" : "unknown";
    }, later);
    is("admissions expiry does not prevent an already-funded drain", drained.accepted, 1);

    part("Erasure uses an index that lives with the pending payload");
    const erased = { ...input, session: "cs_test_shipmentoutbox000004" };
    await enqueueShipmentMail(erased, runtime);
    const retired = { ...runtime, lifecycle: "retired" as const, policy: null };
    const beforeRetired = world.commands.length;
    is("retired lifecycle refuses new storage", await enqueueShipmentMail({ ...input, session: "cs_test_shipmentoutbox000005" }, retired), { ok: false, reason: "unknown" });
    await runShipmentMail(now + 20_000, async () => { throw Error("retirement cannot dispatch"); }, retired);
    is("retired policy never polls or dispatches", world.commands.length, beforeRetired);
    is("retirement retains legacy status", (await shipmentMailStatus(input.statsId, erased.session, retired))?.state, "queued");
    is("retired cleanup erases pending and uncertain payloads without send authorization", await forgetShipmentMail(input.statsId, input.message.to, retired), 2);
    is("no private payload is left indexed", (await shipmentMailStatus(input.statsId, erased.session, runtime))?.state, "not_recorded");
    is("different stores remain separate", shipmentMailId("other_store", input.session) === shipmentMailId(input.statsId, input.session), false);
  } finally {
    if (priorKey === undefined) delete process.env.NIMBUS_DATA_KEY; else process.env.NIMBUS_DATA_KEY = priorKey;
  }
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
