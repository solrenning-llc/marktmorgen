import { readShippedRecord, readShipmentConfirmation, readShipmentMailStatus } from "@/lib/shipment-record";
import { done, is, part } from "./check";

const shipped = { at: 1_790_000_000, tracking: "https://example.com/track" };
part("Fulfillment proof refuses unknown and contradictory replies");
const badRecords: unknown[] = [null, [], {}, { at: 0, tracking: "" }, { at: NaN, tracking: "" }, { at: Infinity, tracking: "" }, { at: 1.5, tracking: "" }, { at: 8_640_000_000_001, tracking: "" }, { at: 1, tracking: 1 }, { at: 1, tracking: "javascript:alert(1)" }, { at: 1, tracking: "https://user:password@example.com/" }, Object.create(shipped)];
for (const value of badRecords) is("unknown records are not shipment proof", readShippedRecord(value), null);
const badReplies: unknown[] = [null, [], {}, { ok: "true", shipped, emailed: true }, { ok: 1, shipped, emailed: true }, { ok: true, shipped }, { ok: true, shipped, emailed: "true" }, { ok: true, shipped: {}, emailed: true }, { ok: true, shipped, emailed: true, error: "stripe" }, Object.create({ ok: true, shipped, emailed: true })];
for (const value of badReplies) is("unconfirmed reply cannot mark the interface as done", readShipmentConfirmation(value, true), null);
is("HTTP failure cannot announce success", readShipmentConfirmation({ ok: true, shipped, emailed: true }, false), null);
is("confirmed email delivery stays distinct", readShipmentConfirmation({ ok: true, shipped, emailed: true }, true), { shipped, emailed: true });
is("no new email is never changed into an email claim", readShipmentConfirmation({ ok: true, shipped, emailed: false }, true), { shipped, emailed: false });
is("records without tracking remain valid", readShippedRecord({ at: shipped.at, tracking: "" }), { at: shipped.at, tracking: "" });
part("Durable mail status never turns waiting into acceptance");
for (const state of ["queued", "on_hold", "acceptance_unknown", "refused", "not_recorded"] as const) {
  const mail = { state, delayed: true };
  is("explicit pending status is preserved", readShipmentConfirmation({ ok: true, shipped, emailed: false, mail }, true), { shipped, emailed: false, mail });
  is("pending status contradicts an acceptance claim", readShipmentConfirmation({ ok: true, shipped, emailed: true, mail }, true), null);
}
is("provider acceptance requires matching explicit proof", readShipmentConfirmation({ ok: true, shipped, emailed: true, mail: { state: "accepted", delayed: false } }, true), { shipped, emailed: true, mail: { state: "accepted", delayed: false } });
is("acceptance cannot accompany a negative acknowledgment", readShipmentConfirmation({ ok: true, shipped, emailed: false, mail: { state: "accepted", delayed: false } }, true), null);
for (const mail of [null, {}, { state: "sent", delayed: false }, { state: "queued", delayed: "true" }, Object.create({ state: "queued", delayed: false }), { get state() { throw Error("not data"); }, delayed: false }]) {
  is("unknown or executable status is not evidence", readShipmentMailStatus(mail), null);
  is("unknown status cannot confirm the route", readShipmentConfirmation({ ok: true, shipped, emailed: false, mail }, true), null);
}
done();
