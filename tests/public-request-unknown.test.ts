/**
 * A store's public request whose count came back in a shape that cannot be
 * read (takePublicRequest, lib/traffic.ts) is not known: it is never "the
 * window is spent" and never room (CX-123 rule 24; follow-up of #3067, which
 * did the same for withinLimit). Until now the one boolean said "no" for
 * both, so withinStore and every route that takes a public request told the
 * person "too many", "try again later" or "this store is resting" when the
 * count could not be read, and the orders link form could even say "sent".
 * Now takePublicRequest throws UnknownReplyError for an unknown count (the
 * window's INCRBY, or the connection's share of the day), and each caller
 * says it could not check just now, while a confirmed spent window answers
 * exactly as before. Redis that cannot be asked at all still refuses the
 * request, as it always has: this counter bounds what the store's month costs.
 *
 * Synthetic data only: the counter's reply is replaced for one key at a time.
 */
import { NextRequest } from "next/server";
import { withinStore } from "@/lib/metered-limits";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, storeForHandle } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { requestOrdersLink } from "@/lib/buyer-orders";
import { ownedBeforeCart } from "@/lib/cart-offers";
import { POST as contactForm } from "@/app/api/store/contact/route";
import { POST as ordersForm } from "@/app/api/store/orders/route";
import { GET as preview } from "@/app/api/store/preview/route";
import { GET as vcard } from "@/app/[handle]/contact/vcard/route";
import { answering as askedBy } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** Which counter answers `reply`: "requests" (the window's INCRBY) or "share" (the connection's HINCRBY); "throw" for a Redis that cannot be asked. */
let target: "" | "requests" | "share" = "";
let reply: unknown = null;
/** How many of the matching commands go through to the stub before `reply` answers (0: the first one answers). */
let skip = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const [command, key] = [String(commands[0]?.[0] ?? ""), String(commands[0]?.[1] ?? "")];
  const hit =
    (target === "requests" && command === "INCRBY" && key.startsWith("nl:traffic:r:")) ||
    (target === "share" && command === "HINCRBY" && key.startsWith("nl:traffic:c:"));
  if (hit && skip > 0) skip -= 1;
  else if (hit) {
    if (reply === "throw") throw new Error("the database did not answer");
    if (reply !== null) return reply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const SPENT = [9_999_999_999];

function answering(on: typeof target, value: unknown, after = 0): void {
  target = on;
  reply = value;
  skip = after;
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

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.RESEND_API_KEY = "re_synthetic";
  globalThis.fetch = (async () => {
    throw new Error("no network in this test");
  }) as typeof fetch;

  await claimHandle("owner@example.com", "requestshop", "Request Shop", "");
  const shop = await storeForHandle("requestshop");
  if (!shop) throw new Error("the synthetic store was not made");

  part("takePublicRequest: an unreadable count is unknown, never a spent window and never room");
  answering("", null);
  is("the real counter takes a request", await outcome(() => takePublicRequest(shop)), "answered true");
  for (const [said, value] of [
    ["a count as text", ["7"]],
    ["a true", [true]],
    ["an empty reply", []],
    ["a second item", [7, 1]],
    ["a count below the units taken", [0]],
    ["no list at all", "OK"],
  ] as const) {
    answering("requests", value);
    is(`${said} is unknown`, await outcome(() => takePublicRequest(shop)), "unknown");
  }
  answering("requests", SPENT);
  is("a confirmed spent window is still a no", await outcome(() => takePublicRequest(shop)), "answered false");
  answering("requests", "throw");
  is("Redis that cannot be asked still refuses, as before", await outcome(() => takePublicRequest(shop)), "answered false");

  part("The connection's share of the day: an unreadable share is unknown, never \"over its share\"");
  askedBy(new Request(`${ORIGIN}/@requestshop`, { headers: { "x-forwarded-for": "203.0.113.40" } }));
  answering("share", [true, 1]);
  is("an unreadable share is unknown", await outcome(() => takePublicRequest(shop, "public", Date.now(), 10)), "unknown");
  askedBy(new Request(`${ORIGIN}/@requestshop`, { headers: { "x-forwarded-for": "203.0.113.41" } }));
  answering("share", [9_999_999, 1]);
  is("a share confirmed past the day's is still a no", await outcome(() => takePublicRequest(shop, "public", Date.now(), 10)), "answered false");
  askedBy(new Request(`${ORIGIN}/@requestshop`, { headers: { "x-forwarded-for": "203.0.113.42" } }));
  answering("", null);
  is("a share within the day's takes the request", await outcome(() => takePublicRequest(shop, "public", Date.now(), 10)), "answered true");
  askedBy(null);

  part("withinStore: the store's unknown count is passed on, never said as a spent window");
  answering("requests", ["7"]);
  is("unknown", await outcome(() => withinStore("request-unit", "who", 5, 60, shop)), "unknown");
  answering("requests", SPENT);
  is("a spent window is still a no", await outcome(() => withinStore("request-unit", "who", 5, 60, shop)), "answered false");
  answering("", null);
  is("room is still a yes", await outcome(() => withinStore("request-unit", "who2", 5, 60, shop)), "answered true");

  part("The contact form: its own error notice, never \"can't take messages\"");
  const contactFields = { handle: "requestshop", name: "Buyer", email: "buyer@example.com", message: "Hello there" };
  answering("requests", ["7"]);
  let response = await contactForm(form("/api/store/contact", contactFields));
  is("unknown: the contact page's error notice", response.headers.get("location"), `${ORIGIN}/@requestshop/contact?status=error`);
  answering("requests", SPENT);
  response = await contactForm(form("/api/store/contact", contactFields));
  is("spent: still 429", response.status, 429);

  part("The orders link form: \"error\", never \"too many\" and never \"sent\"");
  answering("requests", ["7"]);
  response = await ordersForm(form("/api/store/orders", { handle: "requestshop", email: "buyer@example.com" }));
  is("unknown at the form's own request: the orders page's error notice", response.headers.get("location"), `${ORIGIN}/@requestshop/orders?status=error`);
  answering("requests", SPENT);
  response = await ordersForm(form("/api/store/orders", { handle: "requestshop", email: "buyer@example.com" }));
  is("spent: still 429", response.status, 429);
  const recovering = { ...shop, pastBuyers: true };
  answering("requests", ["7"]);
  is("unknown before the link's reads: \"error\"", await outcome(() => requestOrdersLink({ store: recovering, email: "one@example.com", ip: "203.0.113.50", origin: ORIGIN })), "answered \"error\"");
  answering("requests", SPENT);
  is("spent before the link's reads: still \"busy\"", await outcome(() => requestOrdersLink({ store: recovering, email: "two@example.com", ip: "203.0.113.51", origin: ORIGIN })), "answered \"busy\"");

  part("A file or a card read by a link: 503 \"could not be checked\", never \"can't show\" or \"resting\"");
  const previewAt = () => new NextRequest(`${ORIGIN}/api/store/preview?handle=requestshop&product=p1`, { headers: { host: HOST } });
  answering("requests", ["7"]);
  response = await preview(previewAt());
  is("preview unknown: 503", response.status, 503);
  is("preview unknown: never \"can't show previews\"", (await response.text()).includes("can't show previews"), false);
  answering("requests", SPENT);
  response = await preview(previewAt());
  is("preview spent: still 429", response.status, 429);
  const cardAt = () => new NextRequest(`${ORIGIN}/@requestshop/contact/vcard`);
  answering("requests", ["7"]);
  response = await vcard(cardAt(), { params: Promise.resolve({ handle: "@requestshop" }) });
  is("card unknown: 503", response.status, 503);
  is("card unknown: says it could not be checked", (await response.text()).includes("could not be checked"), true);
  answering("requests", SPENT);
  response = await vcard(cardAt(), { params: Promise.resolve({ handle: "@requestshop" }) });
  is("card spent: still 503 with the resting words", (await response.text()).includes("could not be checked"), false);

  part("A cart's offers after paying: nothing offered on an unknown count, as when the window is spent");
  answering("requests", ["7"]);
  is("unknown: nothing is offered", await outcome(() => ownedBeforeCart(shop, "buyer@example.com")), "answered null");
  answering("requests", SPENT);
  is("spent: nothing is offered", await outcome(() => ownedBeforeCart(shop, "buyer@example.com")), "answered null");

  answering("", null);
  done();
}

void main();
