import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/ses/route";
import { reset, world } from "./ses-dedup-ack-world";
import { done, is, part } from "./check";

type Kind = "Notification" | "SubscriptionConfirmation";
function request(kind: Kind) {
  return new NextRequest("https://marktmorgen.com/api/mail/ses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      Type: kind,
      MessageId: "synthetic-sns-claim-1",
      TopicArn: "arn:aws:sns:us-east-1:000000000000:synthetic",
      Message: JSON.stringify({ eventType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "reader@example.test" }] }, mail: { messageId: "synthetic-ses-1", tags: {} } }),
      Timestamp: "2026-11-05T08:00:00.000Z",
      SignatureVersion: "2",
      Signature: "synthetic-verified-boundary",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/synthetic.pem",
      ...(kind === "SubscriptionConfirmation" ? { Token: "synthetic-token", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?synthetic=confirm" } : {}),
    }),
  });
}

async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { world.confirmations++; return new Response("synthetic confirmation", { status: 200 }); };
  try {
    part("An unknown claim cannot authorize an event or confirm a subscription");
    const unknowns: [string, unknown, boolean?][] = [
      ["empty", []], ["missing value", [undefined]], ["false", [false]], ["true", [true]],
      ["number", [1]], ["empty text", [""]], ["wrong text", ["ok"]],
      ["extra successful element", ["OK", null]], ["extra duplicate element", [null, "OK"]],
      ["bare success", "OK"], ["object", {}], ["null envelope", null],
      ["undefined envelope", undefined], ["throw", [], true],
    ];
    for (const kind of ["Notification", "SubscriptionConfirmation"] as const) {
      for (const [label, reply, throws] of unknowns) {
        reset(reply, throws);
        const response = await POST(request(kind)).catch(() => null);
        is(`${kind}/${label}: retryable unknown response`, response?.status, 503);
        is(`${kind}/${label}: no event handler`, world.events.length, 0);
        is(`${kind}/${label}: no confirmation request`, world.confirmations, 0);
        is(`${kind}/${label}: one existing claim command, no unowned cleanup`, world.commands.map(c => c[0]), ["SET"]);
      }
    }
    part("Only the exact success and duplicate acknowledgments keep their behavior");
    for (const kind of ["Notification", "SubscriptionConfirmation"] as const) {
      reset([null]);
      const duplicate = await POST(request(kind));
      is(`${kind}: confirmed duplicate is acknowledged`, [duplicate.status, await duplicate.json()], [200, { ok: true }]);
      is(`${kind}: duplicate has no effect`, [world.events.length, world.confirmations], [0, 0]);
      reset(["OK"]);
      const fresh = await POST(request(kind));
      is(`${kind}: confirmed fresh claim succeeds`, fresh.status, 200);
      is(`${kind}: exactly its expected effect`, [world.events.length, world.confirmations], kind === "Notification" ? [1, 0] : [0, 1]);
      is(`${kind}: existing claim shape and retention stay unchanged`, world.commands, [["SET", "nl:sns:seen:synthetic-sns-claim-1", "1", "NX", "EX", 86_400]]);
    }
  } finally { globalThis.fetch = originalFetch; }
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
