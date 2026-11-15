/**
 * A caption file added by hand, in a language AI captions were paid for and are still being written in
 * (lib/store-caption.ts, lib/auto-captions.ts).
 *
 * The look at a request counts a language as delivered when the video service lists captions in it, whoever put
 * them there. So a creator who paid for Spanish and, while waiting, uploads a Spanish file of their own is never
 * refunded for the Spanish the service did not write, and the service, still writing, may later replace the
 * creator's own file with its own. What must hold: while a language is being written for a video, a file in that
 * language is not taken for it; what the service never wrote is refunded in full.
 */
import { syncAutoCaptions } from "@/lib/auto-captions";
import { GIVE_UP_HOURS } from "@/lib/auto-captions-rules";
import { addStoreCaption } from "@/lib/store-caption";
import { storeFolder, type Store } from "@/lib/store";
import { streamPath } from "@/lib/stream-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const VIDEO = "0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const EMAIL = "manual-captions@example.com";
const PI = "pi_Captions000001";
const CHARGED = 12000;
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHola.\n";

const atService = new Set<string>();
let returned = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "video.bunnycdn.com") {
    const path = url.pathname.replace(/^\/library\/\d+/, "");
    const caption = /^\/videos\/[^/]+\/captions\/([a-z]{2})$/.exec(path);
    if (caption && method === "POST") {
      atService.add(caption[1]);
      return json({ success: true, statusCode: 200 });
    }
    return json({ guid: VIDEO, status: 4, captions: [...atService].map((srclang) => ({ srclang, label: srclang })) });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path.startsWith("/payment_intents/")) return json({ object: "payment_intent", id: PI, currency: "usd", amount_received: CHARGED });
  if (path === "/refunds" && method === "GET") return json({ object: "list", has_more: false, data: [] });
  if (path === "/refunds" && method === "POST") {
    const body = new URLSearchParams(String(init?.body ?? ""));
    const amount = body.has("amount") ? Number(body.get("amount")) : CHARGED - returned;
    returned += amount;
    return json({ id: "re_Refund000001", object: "refund", amount, currency: "usd", payment_intent: PI, status: "succeeded" });
  }
  return json({});
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_captions_only_a_stand_in";
  process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
  process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
  process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";

  const folder = await storeFolder(EMAIL);
  const path = streamPath(folder, "lesson000001", VIDEO);
  const store = { email: EMAIL, sid: "", extra: false, subscriptionActive: true } as unknown as Store;
  const at = Date.UTC(2026, 10, 1);
  await redis.pipeline([
    ["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path, name: "Knife skills.mp4", type: "video/mp4", bytes: 1, state: "ready", at, seconds: 600, width: 1920, height: 1080, settled: true })],
    // English and Spanish paid for, and being written.
    ["SET", `nl:stream:auto:${VIDEO}`, JSON.stringify({ langs: ["en", "es"], got: [], at, cents: CHARGED, pi: PI, path }), "EX", 7 * 86_400],
    ["ZADD", "nl:stream:autoq", at, VIDEO],
  ]);

  part("A file by hand in a language being written by AI");
  const added = await addStoreCaption(store, path, "es", SRT);
  is("not sent to the service while that language is being written", [added.ok, atService.has("es")], [false, false]);

  part("What the service never wrote is refunded in full");
  await syncAutoCaptions(VIDEO, at + (GIVE_UP_HOURS + 1) * 3_600_000);
  is("the whole payment back: neither language came from the service", returned, CHARGED);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
