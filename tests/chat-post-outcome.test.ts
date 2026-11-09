import { postToChat, setChatAddress, chatSetup } from "@/lib/chat-summary";
import { sendPart, weekPeriod } from "@/lib/stats-report";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Rule 24 (CX-123) on a chat post's outcome (Claude 6's review of #3297). A Slack or Discord webhook that timed
// out, was aborted, threw or answered a 5xx may already have shown the post, so that outcome is "unknown", never
// "did not go": a summary part whose post is unknown keeps its once-mark, and a later try answers "earlier"
// instead of posting the same summary again. Only a definite 4xx is "refused". Synthetic webhook; no network.

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const SLACK = "https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnop";
const DISCORD = "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz012345";

type Answer = number | "throws" | "timeout" | "abort";
let answer: Answer = 200;
const requests: string[] = [];

async function main(): Promise<void> {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname !== "hooks.slack.com" && url.hostname !== "discord.com") throw new Error(`No real network request belongs here: ${url.hostname}`);
    requests.push(String(input));
    if (answer === "throws") throw new TypeError("fetch failed");
    if (answer === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (answer === "abort") throw new DOMException("This operation was aborted", "AbortError");
    return new Response("synthetic", { status: answer });
  }) as typeof fetch;

  const post = async (a: Answer, url = SLACK) => {
    answer = a;
    return postToChat(url, "Fixture Store: the week");
  };

  part("postToChat: what the chat answered, three ways");
  is("a 2xx is sent", [await post(200), await post(201, DISCORD)], ["sent", "sent"]);
  is("a definite 4xx is refused", [await post(400), await post(403), await post(404), await post(410, DISCORD), await post(429)], ["refused", "refused", "refused", "refused", "refused"]);
  is("a 5xx may have been shown: unknown", [await post(500), await post(502), await post(503, DISCORD)], ["unknown", "unknown", "unknown"]);
  is("a thrown network error is unknown", await post("throws"), "unknown");
  is("a timeout is unknown", await post("timeout"), "unknown");
  is("an abort is unknown", await post("abort"), "unknown");
  requests.length = 0;
  is("an address of neither kind is refused before any request", [await postToChat("https://example.com/hook", "x"), requests.length], ["refused", 0]);

  part("setChatAddress: anything but sent is refused, and the address is not kept");
  redis.clear();
  for (const a of [404, 503, "throws", "timeout"] as const) {
    answer = a;
    is(`the first message answered ${a}: refused, not kept`, [await setChatAddress("st-fixture", "Fixture Store", SLACK), await chatSetup("st-fixture")], ["refused", null]);
  }
  answer = 200;
  is("a first message taken: saved", [await setChatAddress("st-fixture", "Fixture Store", SLACK), await chatSetup("st-fixture")], ["saved", "slack"]);

  part("sendPart: an unknown outcome keeps the part's mark, so a later try never sends it again");
  redis.clear();
  const period = weekPeriod("fixture-store", Date.parse("2026-11-09T09:00:00Z"));
  let sends = 0;
  const unknown = async () => { sends += 1; return "unknown" as const; };
  const sent = async () => { sends += 1; return "sent" as const; };
  is("the unknown try counts as missed", await sendPart(period, "posted", unknown), "missed");
  is("its mark is kept", redis.run(["GET", `${period.key}:posted`]) !== null, true);
  is("a later try answers earlier and does not send", [await sendPart(period, "posted", sent), sends], ["earlier", 1]);

  part("sendPart controls: a definite refusal lets the mark go; sent and true are sent");
  redis.clear();
  sends = 0;
  const refused = async () => { sends += 1; return "refused" as const; };
  is("refused is missed", await sendPart(period, "posted", refused), "missed");
  is("its mark is let go", redis.run(["GET", `${period.key}:posted`]), null);
  is("a later try sends", [await sendPart(period, "posted", sent), sends], ["sent", 2]);
  redis.clear();
  is("a boolean true (the email's answer) is sent", await sendPart(period, "emailed", async () => true), "sent");
  redis.clear();
  is("a boolean false is missed and lets the mark go", [await sendPart(period, "emailed", async () => false), redis.run(["GET", `${period.key}:emailed`])], ["missed", null]);
  redis.clear();
  is("a send that throws is missed and lets the mark go", [await sendPart(period, "emailed", async () => { throw new Error("synthetic"); }), redis.run(["GET", `${period.key}:emailed`])], ["missed", null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
