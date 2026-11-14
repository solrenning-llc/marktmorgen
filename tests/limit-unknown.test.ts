/**
 * A short-window limit whose count came back in a shape that cannot be read
 * (withinLimit, lib/request-guard.ts) is not known: it is never "past the
 * limit" and never room (CX-123 rule 24; follow-up of #2971). Until now the
 * one boolean said "no" for both, so every caller told the person "too many
 * tries" when the counter could not be read. Now withinLimit throws
 * UnknownReplyError for an unknown count, and each caller says it could not
 * check just now (503 for a route read by code, its own "try again" notice
 * for a form), while a confirmed count past the limit answers exactly as
 * before. Redis that cannot be asked at all still lets the request through,
 * as Claude 1 decided on 05/11/2026 (SG2 17).
 *
 * Synthetic data only: the counter's reply is replaced for one scope at a time.
 */
import { NextRequest } from "next/server";
import { withinLimit } from "@/lib/request-guard";
import { withinStore } from "@/lib/metered-limits";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, storeForHandle } from "@/lib/store";
import { POST as askLibrary } from "@/app/api/library/route";
import { POST as heard } from "@/app/api/store/heard/route";
import { POST as metaDeauthorize } from "@/app/api/integrations/meta/deauthorize/route";
import { POST as mailInbound } from "@/app/api/mail/inbound/route";
import { POST as googleSignIn } from "@/app/api/auth/google/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The scope whose counter answers `reply`; "throw" for a Redis that cannot be asked. */
let target = "";
let reply: unknown = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const key = String(commands[0]?.[1] ?? "");
  if (target && commands[0]?.[0] === "SET" && key.startsWith(`nl:rl:${target}:`)) {
    if (reply === "throw") throw new Error("the database did not answer");
    if (reply !== null) return reply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const UNREADABLE = ["OK", "1"];
const OVER = [null, 9_999];

function answering(scope: string, value: unknown): void {
  target = scope;
  reply = value;
}

async function outcome(call: () => Promise<unknown>): Promise<string> {
  try {
    return `answered ${JSON.stringify(await call())}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}

const HOST = "localhost:3000";
const ORIGIN = `http://${HOST}`;

function form(path: string, fields: Record<string, string>): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
    body: new URLSearchParams(fields).toString(),
  });
}

function json(path: string, body: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("withinLimit: an unreadable count is unknown, never past the limit and never room");
  answering("unit-scope", UNREADABLE);
  is("an unreadable count is unknown", await outcome(() => withinLimit("unit-scope", "who", 5, 60)), "unknown");
  answering("unit-scope", ["OK"]);
  is("a cut-short reply is unknown", await outcome(() => withinLimit("unit-scope", "who", 5, 60)), "unknown");
  answering("unit-scope", OVER);
  is("a count past the limit is still a no", await outcome(() => withinLimit("unit-scope", "who", 5, 60)), "answered false");
  answering("unit-scope", [null, 5]);
  is("the last count within is still a yes", await outcome(() => withinLimit("unit-scope", "who", 5, 60)), "answered true");
  answering("unit-scope", "throw");
  is("Redis that cannot be asked still lets the request through", await outcome(() => withinLimit("unit-scope", "who", 5, 60)), "answered true");
  answering("", null);
  is("the real counter still counts", await outcome(() => withinLimit("unit-scope", "who", 5, 60)), "answered true");

  await claimHandle("owner@example.com", "limitshop", "Limit Shop", "");
  const shop = await storeForHandle("limitshop");
  if (!shop) throw new Error("the synthetic store was not made");

  part("withinStore: the short window's unknown count is passed on, never said as spent");
  answering("store-scope", UNREADABLE);
  is("unknown", await outcome(() => withinStore("store-scope", "who", 5, 60, shop)), "unknown");
  answering("store-scope", OVER);
  is("past the short window is still a no", await outcome(() => withinStore("store-scope", "who", 5, 60, shop)), "answered false");

  part("A form whose limit is checked inside its library function: the honest error notice, never \"limited\"");
  // A sender key so the form reaches its limit; nothing is sent on an unknown or spent count, and fetch refuses.
  process.env.RESEND_API_KEY = "re_synthetic";
  globalThis.fetch = (async () => {
    throw new Error("no network in this test");
  }) as typeof fetch;
  answering("library-ip", UNREADABLE);
  let response = await askLibrary(form("/api/library", { email: "buyer@example.com" }));
  is("unknown: the library page says it did not work, try again", response.headers.get("location"), `${ORIGIN}/library?status=error`);
  answering("library-ip", OVER);
  response = await askLibrary(form("/api/library", { email: "buyer@example.com" }));
  is("past the limit: still \"limited\"", response.headers.get("location"), `${ORIGIN}/library?status=limited`);

  part("A store route read by code (withinStore): 503, never 429");
  answering("heard", UNREADABLE);
  response = await heard(json("/api/store/heard", { h: "limitshop", s: "cs_test_1", a: "friend" }));
  is("unknown: 503", response.status, 503);
  answering("heard", OVER);
  response = await heard(json("/api/store/heard", { h: "limitshop", s: "cs_test_1", a: "friend" }));
  is("past the limit: still 429", response.status, 429);

  part("A provider's callback: 503, so it is sent again, never \"Too many requests\"");
  process.env.META_APP_ID = "123456789";
  process.env.META_APP_SECRET = "synthetic-secret";
  answering("metaads-deauth", UNREADABLE);
  response = await metaDeauthorize(form("/api/integrations/meta/deauthorize", { signed_request: "x" }));
  is("unknown: 503", response.status, 503);
  is("unknown: never says too many", (await response.text()).includes("Too many"), false);
  answering("metaads-deauth", OVER);
  response = await metaDeauthorize(form("/api/integrations/meta/deauthorize", { signed_request: "x" }));
  is("past the limit: still 429", response.status, 429);
  answering("", null);
  response = await metaDeauthorize(form("/api/integrations/meta/deauthorize", { signed_request: "x" }));
  is("within: on to its own checks (a bad signature is 400)", response.status, 400);

  part("Resend's webhook: 503 for an unknown count, so Resend sends it again");
  process.env.RESEND_WEBHOOK_SECRET = "whsec_c3ludGhldGlj";
  answering("mail-inbound", UNREADABLE);
  response = await mailInbound(json("/api/mail/inbound", {}));
  is("unknown: 503", response.status, 503);
  answering("mail-inbound", OVER);
  response = await mailInbound(json("/api/mail/inbound", {}));
  is("past the limit: still 429", response.status, 429);

  part("Logging in with Google: \"did not work just now\", never \"Too many tries\"");
  process.env.GOOGLE_SIGNIN_LIVE = "1";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "synthetic-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "synthetic-secret";
  const atSite = () =>
    new NextRequest("https://marktmorgen.com/api/auth/google", {
      method: "POST",
      headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-proto": "https", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" },
      body: "",
    });
  answering("google-signin", UNREADABLE);
  response = await googleSignIn(atSite());
  is("unknown: the error notice", response.headers.get("location"), "https://marktmorgen.com/signin?status=google-error");
  answering("google-signin", OVER);
  response = await googleSignIn(atSite());
  is("past the limit: still google-slow", response.headers.get("location"), "https://marktmorgen.com/signin?status=google-slow");

  done();
}

void main();
