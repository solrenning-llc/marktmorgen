import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/ses/route";
import { SNS_RECEIPT_COMMANDS_MOST, SNS_RECEIPT_DONE, SNS_RECEIPT_LEASE_MS, SNS_RECEIPT_SECONDS, SNS_RECEIPT_VALUE_BYTES_MOST, takeSnsReceipt } from "@/lib/sns-receipt";
import { again, reset, world, type Fault } from "./ses-dedup-ack-world";
import { done, is, part } from "./check";

type Kind = "Notification" | "SubscriptionConfirmation";
const KEY = "nl:sns:seen:synthetic-sns-claim-1";
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
const held = () => world.redis.run(["GET", KEY]);
const names = () => world.commands.map((command) => command[0]);
/** Every EVAL sent is one of the owner-bound scripts: a let-go or a swap that compares the value first. */
const ownerBound = () => world.commands.filter((command) => command[0] === "EVAL").every((command) => /^-- marktmorgen:(release|sns-receipt-swap):v1\n/.test(String(command[1])));
const effects = () => [world.events.length, world.confirmations];
const stale = (now = Date.now()) => `${now - SNS_RECEIPT_LEASE_MS - 1_000}.000000001`;
let mostBilled = 0;
const bill = () => { mostBilled = Math.max(mostBilled, world.billed); };

async function main() {
  const originalFetch = globalThis.fetch;
  const realNow = Date.now;
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
        // The claim did not land and its answer does not read: the key is read back and holds nothing of ours.
        reset({ on: "SET", reply, throws, applied: false });
        const response = await POST(request(kind)).catch(() => null);
        bill();
        is(`${kind}/${label}: retryable unknown response`, response?.status, 503);
        is(`${kind}/${label}: no event handler`, world.events.length, 0);
        is(`${kind}/${label}: no confirmation request`, world.confirmations, 0);
        is(`${kind}/${label}: read back, never an unowned cleanup`, [names().slice(0, 2), names().includes("DEL"), ownerBound()], [["SET", "GET"], false, true]);
        is(`${kind}/${label}: nothing is left behind`, held(), null);
      }
      // The answer does not read and neither does the read-back: nothing is acted on.
      reset({ on: "SET", reply: [], applied: false }, { on: "GET", throws: true, applied: false });
      const blind = await POST(request(kind));
      bill();
      is(`${kind}: an unreadable claim and read-back act on nothing`, [blind.status, ...effects()], [503, 0, 0]);
      // Another run's fresh pending value is there: an unreadable answer never takes it, nor lets it go.
      reset({ on: "SET", reply: [false], applied: true });
      const other = `${Date.now()}.000000007`;
      world.redis.run(["SET", KEY, other, "EX", SNS_RECEIPT_SECONDS]);
      const busy = await POST(request(kind));
      bill();
      is(`${kind}: another run's pending claim is neither acted on nor let go`, [busy.status, ...effects(), held()], [503, 0, 0, other]);
    }

    part("Only the exact success and duplicate acknowledgments keep their behavior");
    for (const kind of ["Notification", "SubscriptionConfirmation"] as const) {
      reset();
      world.redis.run(["SET", KEY, SNS_RECEIPT_DONE, "EX", SNS_RECEIPT_SECONDS]);
      const duplicate = await POST(request(kind));
      bill();
      is(`${kind}: confirmed duplicate is acknowledged`, [duplicate.status, await duplicate.json()], [200, { ok: true }]);
      is(`${kind}: duplicate has no effect`, effects(), [0, 0]);
      is(`${kind}: a finished notice costs its claim and one read`, names(), ["SET", "GET"]);
      reset();
      const fresh = await POST(request(kind));
      bill();
      is(`${kind}: confirmed fresh claim succeeds`, fresh.status, 200);
      is(`${kind}: exactly its expected effect`, effects(), kind === "Notification" ? [1, 0] : [0, 1]);
      const [claim, finish] = world.commands;
      is(`${kind}: the claim is a pending value of this run, kept a day`, [claim.length, claim[0], claim[1], /^[0-9]{13}\.[0-9]{9}$/.test(String(claim[2])), String(claim[2]).length <= SNS_RECEIPT_VALUE_BYTES_MOST, claim.slice(3)], [6, "SET", KEY, true, true, ["NX", "EX", 86_400]]);
      is(`${kind}: then marked done over that value only`, [world.commands.length, finish[0], finish.slice(2)], [2, "EVAL", [1, KEY, claim[2], SNS_RECEIPT_DONE, 86_400]]);
      is(`${kind}: and done is kept a day`, [held(), world.redis.run(["TTL", KEY])], [SNS_RECEIPT_DONE, 86_400]);
      again();
      const repeat = await POST(request(kind));
      is(`${kind}: the same notice again is acknowledged without acting`, [repeat.status, ...effects()], [200, ...(kind === "Notification" ? [1, 0] : [0, 1])]);
    }

    part("A failure while acting lets go of its own claim, and the retry acts");
    reset();
    world.failRecord = true;
    const failed = await POST(request("Notification"));
    bill();
    is("the failure is answered so Amazon tries again", [failed.status, world.events.length, held()], [500, 0, null]);
    is("only by an owner-bound let-go", [names().includes("DEL"), ownerBound()], [false, true]);
    world.failRecord = false;
    again();
    const retried = await POST(request("Notification"));
    is("the retry acts once and finishes", [retried.status, world.events.length, held()], [200, 1, SNS_RECEIPT_DONE]);

    part("An applied claim with a lost response must not become a completed duplicate");
    for (const [label, reply, throws] of [
      ["empty reply", [], false], ["false reply", [false], false],
      ["extra reply", ["OK", null], false], ["thrown reply", [], true],
    ] as const) {
      // Redis applied SET but its reply was lost: the read-back finds this run's own value.
      reset({ on: "SET", reply, throws, applied: true });
      await POST(request("Notification")).catch(() => null);
      bill();
      const retry = await POST(request("Notification"));
      is(`${label}: do not acknowledge an unfinished event as complete`, retry.status !== 200 || world.events.length === 1, true);
      is(`${label}: acted on exactly once, and finished`, [world.events.length, held()], [1, SNS_RECEIPT_DONE]);
    }

    part("Every answer lost: the lease, not an acknowledgment, decides");
    for (const [label, faults] of [
      ["claim and read-back lost", [{ on: "SET", reply: [], applied: true }, { on: "GET", throws: true, applied: false }, { on: "EVAL", throws: true, applied: false }]],
      ["claim, read-back and let-go lost", [{ on: "SET", throws: true, applied: true }, { on: "GET", reply: [false], applied: false }, { on: "EVAL", reply: [], applied: false }]],
    ] as [string, Fault[]][]) {
      reset(...faults);
      const first = await POST(request("Notification"));
      bill();
      is(`${label}: nothing acted on, failure answered`, [first.status, world.events.length], [503, 0]);
      is(`${label}: the pending value stays`, /^[0-9]{13}\.[0-9]{9}$/.test(String(held())), true);
      again();
      const soon = await POST(request("Notification"));
      bill();
      is(`${label}: a retry inside the lease is told to come back, never acknowledged`, [soon.status, world.events.length], [503, 0]);
      const later = realNow() + SNS_RECEIPT_LEASE_MS + 1_000;
      Date.now = () => later;
      try {
        again();
        const late = await POST(request("Notification"));
        bill();
        is(`${label}: a retry after the lease takes it over and acts`, [late.status, world.events.length, held()], [200, 1, SNS_RECEIPT_DONE]);
        is(`${label}: the take-over is owner-bound`, [names().includes("DEL"), ownerBound()], [false, true]);
        again();
        const last = await POST(request("Notification"));
        is(`${label}: then the notice is a finished duplicate`, [last.status, world.events.length], [200, 1]);
      } finally { Date.now = realNow; }
    }

    part("A run that ended unfinished, or the route's old receipt, is acted on again");
    for (const [label, value] of [["a pending value past its lease", stale()], ["the old receipt \"1\"", "1"], ["an unreadable value", "x"]] as const) {
      reset();
      world.redis.run(["SET", KEY, value, "EX", SNS_RECEIPT_SECONDS]);
      const response = await POST(request("Notification"));
      bill();
      is(`${label}: taken over, acted on and finished`, [response.status, world.events.length, held()], [200, 1, SNS_RECEIPT_DONE]);
      if (label.startsWith("a pending")) is("the most a delivery's receipt is billed: claim, read, take-over and done", world.billed, SNS_RECEIPT_COMMANDS_MOST);
    }
    reset();
    world.redis.run(["SET", KEY, stale(), "EX", SNS_RECEIPT_SECONDS]);
    world.failRecord = true;
    const lostAgain = await POST(request("Notification"));
    bill();
    is("a take-over that fails lets go and answers the failure", [lostAgain.status, world.events.length, held()], [500, 0, null]);
    is("the same most on the failing take-over", world.billed, SNS_RECEIPT_COMMANDS_MOST);
    reset();
    world.redis.run(["SET", KEY, stale(), "EX", SNS_RECEIPT_SECONDS]);
    const one = await takeSnsReceipt(KEY);
    const two = await takeSnsReceipt(KEY);
    is("two late deliveries never both take over the same run", [one.state, two.state], ["ours", "busy"]);
    reset({ on: "EVAL", reply: [0], applied: false });
    world.redis.run(["SET", KEY, stale(), "EX", SNS_RECEIPT_SECONDS]);
    is("a take-over that is not confirmed acts on nothing", (await takeSnsReceipt(KEY)).state, "busy");

    part("What a delivery's receipt can cost");
    is("no path is billed more than the counted most", mostBilled, SNS_RECEIPT_COMMANDS_MOST);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = realNow;
  }
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
