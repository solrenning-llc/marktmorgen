import { readSesEvent } from "@/lib/sns";
import { done, is, part } from "./check";

type EventType = "Bounce" | "Complaint" | "Delivery" | "DeliveryDelay";

function message(type: EventType, recipients: unknown): string {
  const body = type === "Bounce"
    ? { bounceType: "Permanent", bouncedRecipients: recipients, timestamp: "2026-11-06T00:00:00Z" }
    : type === "Complaint"
      ? { complainedRecipients: recipients, timestamp: "2026-11-06T00:00:00Z" }
      : type === "Delivery"
        ? { recipients, timestamp: "2026-11-06T00:00:00Z" }
        : { delayedRecipients: recipients, timestamp: "2026-11-06T00:00:00Z" };
  const field = type === "Bounce" ? "bounce" : type === "Complaint" ? "complaint"
    : type === "Delivery" ? "delivery" : "deliveryDelay";
  return JSON.stringify({
    eventType: type,
    [field]: body,
    mail: {
      messageId: "synthetic-message",
      tags: {
        marktmorgen_store: ["a".repeat(32)],
        marktmorgen_list: ["b".repeat(32)],
      },
    },
  });
}

function rejectsKnownEvent(name: string, type: EventType, recipients: unknown): void {
  let rejected = false;
  try {
    readSesEvent(message(type, recipients));
  } catch {
    rejected = true;
  }
  is(name, rejected, true);
}

function main(): void {
  part("A provider event is unknown unless every recipient is readable");
  const malformed: [string, EventType, unknown][] = [
    ["bounce partial", "Bounce", [{ emailAddress: "one@example.test" }, {}]],
    ["complaint missing address", "Complaint", [{}]],
    ["delivery partial", "Delivery", ["one@example.test", 7]],
    ["delay partial", "DeliveryDelay", [{ emailAddress: "one@example.test" }, null]],
    ["empty list", "Bounce", []],
    ["not a list", "Complaint", { emailAddress: "one@example.test" }],
    ["address too long", "Delivery", [`${"a".repeat(310)}@example.test`]],
    ["more than one event can report", "Delivery", Array.from({ length: 51 }, (_, i) => `member${i}@example.test`)],
  ];
  for (const [name, type, recipients] of malformed) {
    rejectsKnownEvent(name, type, recipients);
  }
  Object.defineProperty(Object.prototype, "emailAddress", { configurable: true, value: "inherited@example.test" });
  try {
    rejectsKnownEvent("an inherited address is not provider evidence", "Bounce", [{}]);
  } finally {
    delete (Object.prototype as { emailAddress?: unknown }).emailAddress;
  }

  part("Exact AWS shapes remain accepted and unrelated events stay ignorable");
  is("bounce object", readSesEvent(message("Bounce", [{ emailAddress: "one@example.test" }]))?.recipients, ["one@example.test"]);
  is("complaint object", readSesEvent(message("Complaint", [{ emailAddress: "two@example.test" }]))?.recipients, ["two@example.test"]);
  is("delivery string", readSesEvent(message("Delivery", ["three@example.test"]))?.recipients, ["three@example.test"]);
  is("delay object", readSesEvent(message("DeliveryDelay", [{ emailAddress: "four@example.test" }]))?.recipients, ["four@example.test"]);
  is("permanent bounce remains permanent", readSesEvent(message("Bounce", [{ emailAddress: "one@example.test" }]))?.permanent, true);
  is("unrelated event remains unsupported", readSesEvent(JSON.stringify({ eventType: "Send" })), null);
  done();
}

main();
