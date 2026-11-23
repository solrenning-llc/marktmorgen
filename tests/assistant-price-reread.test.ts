/**
 * Board #5285 row #3107 (Claude 1's LOW): when Stripe makes the add-on's price but the reply to POST /prices does not
 * read as the price just written, the lookup key is read once more before giving up. The price found there is used only
 * when it is the add-on's own (isAssistantPrice), exactly as a price found before the POST; anything else still fails,
 * nothing is cached, and the next checkout asks Stripe again. Synthetic provider replies only.
 */
import { ensureAssistantPrice, ASSISTANT_LOOKUP_KEY, ASSISTANT_PRODUCT_ID } from "@/lib/assistant-billing";
import { ASSISTANT_PRICE_CENTS } from "@/lib/store-assistant-rules";
import { done, is, part } from "./check";

type Listed = "none" | "own" | "amount" | "count";

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_assistant_price_reread_only";
  /** What each GET of the lookup key answers, in order; empty: an empty list. */
  const lookups: Listed[] = [];
  /** What the POST /prices reply is: a 200 whose body is `null`, a 200 with an error shape and no id, or the price written. */
  let postAs: "null" | "no-id" | "written" = "null";
  let pricesMade = 0;
  let lookupsAsked = 0;
  let requests = 0;
  const priceOf = (id: string, listed: Listed): Record<string, unknown> => ({
    id,
    object: "price",
    active: true,
    unit_amount: listed === "amount" ? ASSISTANT_PRICE_CENTS - 1 : ASSISTANT_PRICE_CENTS,
    currency: "usd",
    recurring: { interval: "month", interval_count: listed === "count" ? 2 : 1 },
    lookup_key: ASSISTANT_LOOKUP_KEY,
    product: ASSISTANT_PRODUCT_ID,
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request");
    requests += 1;
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/v1/prices") {
      lookupsAsked += 1;
      is("the lookup asks the add-on's own key, active only", [url.searchParams.get("lookup_keys[]"), url.searchParams.get("active")], [ASSISTANT_LOOKUP_KEY, "true"]);
      const next = lookups.length ? lookups.shift()! : "none";
      return Response.json({ object: "list", data: next === "none" ? [] : [priceOf("price_ReadAgain0" + pricesMade, next)], has_more: false });
    }
    if (method === "GET" && url.pathname === `/v1/products/${ASSISTANT_PRODUCT_ID}`) return Response.json({ id: ASSISTANT_PRODUCT_ID, object: "product" });
    if (method === "POST" && url.pathname === "/v1/prices") {
      pricesMade += 1;
      if (postAs === "null") return Response.json(null);
      if (postAs === "no-id") return Response.json({ object: "price" });
      return Response.json(priceOf("price_Written0" + pricesMade, "own"));
    }
    throw new Error("Unexpected provider operation: " + method + " " + url.pathname);
  }) as typeof fetch;
  const attempt = async (): Promise<string> => {
    try {
      return await ensureAssistantPrice();
    } catch (error) {
      return "threw: " + (error instanceof Error ? error.message : String(error));
    }
  };
  try {
    part("An odd POST reply, and the lookup key still empty: the checkout fails, nothing is kept");
    lookups.push("none", "none");
    postAs = "null";
    is("it fails as before", (await attempt()).startsWith("threw: "), true);
    is("one price made, the lookup read before and once after", [pricesMade, lookupsAsked], [1, 2]);

    part("An odd POST reply, and the key now holds a price at another amount: never used");
    [pricesMade, lookupsAsked] = [0, 0];
    lookups.push("none", "amount");
    postAs = "no-id";
    is("it fails", (await attempt()).startsWith("threw: "), true);
    is("one price made, read once after", [pricesMade, lookupsAsked], [1, 2]);

    part("An odd POST reply, and the key now holds a price every two months: never used");
    [pricesMade, lookupsAsked] = [0, 0];
    lookups.push("none", "count");
    postAs = "null";
    is("it fails", (await attempt()).startsWith("threw: "), true);
    is("one price made, read once after", [pricesMade, lookupsAsked], [1, 2]);

    part("An odd POST reply, and the key now holds the price just made: used, and no second price is made");
    [pricesMade, lookupsAsked] = [0, 0];
    lookups.push("none", "own");
    postAs = "null";
    is("the add-on's own price is given to the checkout", await attempt(), "price_ReadAgain01");
    is("one price made, read once after", [pricesMade, lookupsAsked], [1, 2]);
    const before = requests;
    is("the next checkout uses the same price", await attempt(), "price_ReadAgain01");
    is("without asking Stripe again or making another price", [requests - before, pricesMade], [0, 1]);
  } finally {
    globalThis.fetch = original;
  }
  done();
}

void main();
