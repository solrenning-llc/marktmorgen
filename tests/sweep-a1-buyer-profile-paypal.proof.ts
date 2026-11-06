/**
 * CX-123 rule 24 proof for the creator's buyer report.
 *
 * The paid PayPal row is written by the real in-memory Redis writer. Only the
 * single GET reply used by buyerProfile is replaced. An unknown reply must not
 * become a confirmed zero-dollar imported purchase.
 */
import assert from "node:assert/strict";
import { buyerProfile } from "@/lib/buyer-profile";
import { grantImported } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const STATS = "a".repeat(32);
const ORDER = "ORDER1234567890";
const EMAIL = "buyer@example.com";
const PRODUCT = "guide1";
const PAID_KEY = `nl:ppsell:paid:${ORDER}`;

const store = {
  sid: "sid-proof-001",
  handle: "proof-shop",
  previousHandles: [],
  releasedHandles: [],
  name: "Proof shop",
  email: "owner@example.com",
  statsId: STATS,
  listId: null,
  callsId: null,
  currency: "usd",
  language: "en",
  stripeAccountId: null,
  pastBuyers: true,
  catalog: {
    id: null,
    head: [],
    items: [{ id: PRODUCT, kind: 0, options: [] }],
    inline: [{ id: PRODUCT, title: "Paid guide", course: null, options: [] }],
  },
} as unknown as Store;

const paid = {
  store: STATS,
  order: ORDER,
  capture: "CAPTURE-123",
  email: EMAIL,
  product: PRODUCT,
  cents: 4200,
  currency: "usd",
  at: 1_799_000_000,
  handle: store.handle,
};

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);

async function world(reply: unknown[] | null): Promise<Awaited<ReturnType<typeof buyerProfile>>> {
  redis.clear();
  await grantImported(STATS, `paypal:${ORDER}`, [{ email: EMAIL, productId: PRODUCT, items: null }], paid.at, store.sid);
  await original([["SET", PAID_KEY, JSON.stringify(paid)]]);

  let injected = 0;
  redis.pipeline = async (commands: Command[]) => {
    if (reply !== null && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === PAID_KEY) {
      injected += 1;
      return reply;
    }
    return original(commands);
  };
  try {
    const profile = await buyerProfile(store, EMAIL);
    if (reply !== null) assert.equal(injected, 1, "the paid-row reply was not replaced");
    return profile;
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Controls");
  const healthy = await world(null);
  is("the real paid row is counted as a PayPal sale", [healthy.paid, healthy.orders[0]?.kind], [4200, "sale"]);

  const absent = await world([null]);
  is("confirmed absence keeps only the historical grant", [absent.paid, absent.orders[0]?.kind], [0, "brought"]);

  part("Unknown paid-row replies");
  for (const [name, reply] of [
    ["missing outer reply", []],
    ["undefined slot", [undefined]],
    ["wrong slot type", [42]],
    ["unreadable text", ["{"]],
  ] as const) {
    let refused = false;
    let profile: Awaited<ReturnType<typeof buyerProfile>> | null = null;
    try {
      profile = await world([...reply]);
    } catch {
      refused = true;
    }
    is(`${name} is unavailable, not ${profile?.orders[0]?.kind ?? "no order"} with paid=${profile?.paid ?? "unknown"}`, refused, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
