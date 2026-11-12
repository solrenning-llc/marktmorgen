/**
 * Two looks at one captions request at once, when it gives up (lib/auto-captions.ts, syncAutoCaptions -> settle).
 *
 * The video service's announcement (app/api/stream/hook) and the five-minute sweep both call syncAutoCaptions. Each
 * reads the record, asks the service what it has written, and settles. Past GIVE_UP_HOURS, a look that read the
 * service a moment before a language arrived settles as if nothing was delivered, while the other look, which read it
 * after, settles with that language delivered. Both refund under the same idempotency key with different amounts:
 * Stripe refuses a key reused with other parameters, the stale look records the WHOLE payment as owed, and the sweep
 * then returns the rest, so a language that was delivered is refunded too.
 *
 * What must hold: however many looks run at once, the money returned is what the first settlement decided, never
 * more than the languages that were not delivered.
 */
import { syncAutoCaptions } from "@/lib/auto-captions";
import { GIVE_UP_HOURS } from "@/lib/auto-captions-rules";
import { streamPath } from "@/lib/stream-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const VIDEO = "0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const FOLDER = "a".repeat(32);
const PATH = streamPath(FOLDER, "lesson000001", VIDEO);
const PI = "pi_Captions000001";
const CHARGED = 12000;

type Refund = { id: string; object: "refund"; amount: number; currency: "usd"; payment_intent: string; status: "succeeded" };
const refunds: Refund[] = [];
/** Stripe's idempotency: the first body under a key is replayed; another body under it is refused. */
const keys = new Map<string, { body: string; made: Refund }>();
/** Answers held back for the next GET of the video, in order; empty answers at once with `captionsNow`. */
const held: { release: (langs: string[]) => void; promise: Promise<string[]> }[] = [];
let captionsNow: string[] = [];
let holdNext = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "video.bunnycdn.com") {
    let langs = captionsNow;
    if (holdNext > 0) {
      holdNext -= 1;
      let release: (l: string[]) => void = () => {};
      const promise = new Promise<string[]>((resolve) => { release = resolve; });
      held.push({ release, promise });
      langs = await promise;
    }
    return json({ guid: VIDEO, status: 4, captions: langs.map((srclang) => ({ srclang, label: srclang })) });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path.startsWith("/payment_intents/") && method === "GET") {
    return json({ object: "payment_intent", id: PI, currency: "usd", amount_received: CHARGED });
  }
  if (path === "/refunds" && method === "GET") return json({ object: "list", has_more: false, data: refunds.slice().reverse() });
  if (path === "/refunds" && method === "POST") {
    const body = String(init?.body ?? "");
    const params = new URLSearchParams(body);
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    const seen = keys.get(key);
    if (seen) {
      if (seen.body !== body) return json({ error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } }, 400);
      return json(seen.made);
    }
    const left = CHARGED - refunds.reduce((sum, r) => sum + r.amount, 0);
    const asked = params.has("amount") ? Number(params.get("amount")) : left;
    if (asked <= 0 || asked > left) return json({ error: { type: "invalid_request_error", code: "amount_too_large" } }, 400);
    const made: Refund = { id: `re_Refund${String(refunds.length + 1).padStart(6, "0")}`, object: "refund", amount: asked, currency: "usd", payment_intent: PI, status: "succeeded" };
    refunds.push(made);
    keys.set(key, { body, made });
    return json(made);
  }
  return json({});
}) as typeof fetch;

const returned = () => refunds.reduce((sum, r) => sum + r.amount, 0);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_captions_only_a_stand_in";
  process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
  process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
  process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";

  part("Two looks at once, as the request gives up, return only what was not delivered");
  const at = Date.UTC(2026, 10, 1);
  const now = at + (GIVE_UP_HOURS + 1) * 3_600_000;
  // English and Spanish were paid for; English is written, Spanish never comes.
  await redis.pipeline([
    ["SET", `nl:stream:auto:${VIDEO}`, JSON.stringify({ langs: ["en", "es"], got: [], at, cents: CHARGED, pi: PI, path: PATH }), "EX", 7 * 86_400],
    ["ZADD", "nl:stream:autoq", now, VIDEO],
  ]);

  // The sweep reads the service just before English is listed there, and its answer is slow to come back.
  holdNext = 1;
  const stale = syncAutoCaptions(VIDEO, now);
  while (!held.length) await new Promise((resolve) => setTimeout(resolve, 1));
  // Meanwhile English arrives, and the service's announcement looks and settles first.
  captionsNow = ["en"];
  const fresh = await syncAutoCaptions(VIDEO, now);
  is("the announcement's look settles, refunding Spanish only", [fresh, returned()], ["done", CHARGED / 2]);
  // Now the sweep's slow answer, read before English was there, comes back.
  held[0].release([]);
  await stale;
  // And the sweep goes on with whatever the record says afterward, as it would every five minutes.
  for (let look = 1; look <= 5; look += 1) await syncAutoCaptions(VIDEO, now + look * 3_600_000);

  is("never more returned than the language that was not delivered", returned(), CHARGED / 2);
  is("the record is gone, nothing left owed", redis.run(["GET", `nl:stream:auto:${VIDEO}`]), null);

  part("A look that saw nothing delivered never refunds a request another look settled as delivered");
  // A new payment of its own: Stripe's refunds of the first one are not this one's.
  refunds.length = 0;
  keys.clear();
  const before = returned();
  const at2 = at + 1;
  await redis.pipeline([
    ["SET", `nl:stream:auto:${VIDEO}`, JSON.stringify({ langs: ["en", "es"], got: [], at: at2, cents: CHARGED, pi: PI, path: PATH }), "EX", 7 * 86_400],
    ["ZADD", "nl:stream:autoq", now, VIDEO],
  ]);
  captionsNow = [];
  holdNext = 1;
  held.length = 0;
  const late = syncAutoCaptions(VIDEO, now);
  while (!held.length) await new Promise((resolve) => setTimeout(resolve, 1));
  captionsNow = ["en", "es"];
  is("the look that saw both languages settles with nothing to give back", [await syncAutoCaptions(VIDEO, now), returned() - before], ["done", 0]);
  held[0].release([]);
  await late;
  for (let look = 1; look <= 5; look += 1) await syncAutoCaptions(VIDEO, now + look * 3_600_000);
  is("nothing returned for languages that were delivered", returned() - before, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
