import { postToChat, setChatAddress, chatSetup } from "@/lib/chat-summary";
import { EMAIL_KEY_HOLDS_MS, sendPart, weekPeriod } from "@/lib/stats-report";
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
  is("the unknown try is unconfirmed, not missed", await sendPart(period, "posted", unknown), "unconfirmed");
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
  is("a boolean false, with no key window, may be an unknown: unconfirmed, and the mark is kept",
    [await sendPart(period, "emailed", async () => false), redis.run(["GET", `${period.key}:emailed`]) !== null], ["unconfirmed", true]);
  redis.clear();
  is("a send that throws may have gone: unconfirmed, and the mark is kept",
    [await sendPart(period, "emailed", async () => { throw new Error("synthetic"); }), redis.run(["GET", `${period.key}:emailed`]) !== null], ["unconfirmed", true]);

  // Claude 2's first review of #3297 (MEDIUM): sendEmail answers false for a refusal and for an unknown alike, and
  // its key holds a day. A false is tried again only while the first try is that recent.
  part("sendPart with the email's key window: a false is tried again only while the key holds");
  const realNow = Date.now;
  const start = Date.parse("2026-11-09T00:20:00Z");
  let clock = start;
  Date.now = () => clock;
  try {
    redis.clear();
    sends = 0;
    const no = async () => { sends += 1; return false; };
    const window = { keyHoldsMs: EMAIL_KEY_HOLDS_MS };
    is("a false inside the window is missed and lets the mark go", [await sendPart(period, "emailed", no, window), redis.run(["GET", `${period.key}:emailed`])], ["missed", null]);
    is("the first try's time is kept with the period", redis.run(["GET", `${period.key}:emailed:first`]), String(start));
    clock = start + EMAIL_KEY_HOLDS_MS - 60_000;
    is("a minute before the window ends, it is tried again", [await sendPart(period, "emailed", no, window), sends], ["missed", 2]);
    is("the first try's time is not moved by a later try", redis.run(["GET", `${period.key}:emailed:first`]), String(start));
    clock = start + EMAIL_KEY_HOLDS_MS;
    is("once the window has passed, it is not tried: unconfirmed, nothing sent", [await sendPart(period, "emailed", sent, window), sends], ["unconfirmed", 2]);
    is("and its mark is kept, so no later try sends it", [redis.run(["GET", `${period.key}:emailed`]) !== null, await sendPart(period, "emailed", sent, window), sends], [true, "earlier", 2]);

    for (const [label, reply] of [["a number", 7], ["a list", ["1"]], ["a non-numeric string", "soon"]] as const) {
      redis.clear();
      sends = 0;
      redis.run(["SET", `${period.key}:emailed:first`, "placeholder"]);
      const oldPipeline = redis.pipeline.bind(redis);
      redis.pipeline = async (batch) => {
        const replies = await oldPipeline(batch);
        return replies.map((r, i) => (batch[i][0] === "GET" && String(batch[i][1]).endsWith(":emailed:first") ? reply : r));
      };
      try {
        is(`the first try's time answered as ${label}: nothing sent, missed, the mark let go`,
          [await sendPart(period, "emailed", sent, window), sends, redis.run(["GET", `${period.key}:emailed`])], ["missed", 0, null]);
      } finally {
        redis.pipeline = oldPipeline;
      }
    }

    redis.clear();
    sends = 0;
    clock = start;
    is("control: sent inside the window is sent", [await sendPart(period, "emailed", sent, window), sends], ["sent", 1]);
    redis.clear();
    is("control: refused inside the window is missed", await sendPart(period, "emailed", refused, window), "missed");
    redis.clear();
    is("control: unknown inside the window is unconfirmed", await sendPart(period, "emailed", unknown, window), "unconfirmed");
  } finally {
    Date.now = realNow;
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
