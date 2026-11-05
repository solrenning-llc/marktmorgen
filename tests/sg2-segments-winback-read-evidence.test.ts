/**
 * RED evidence for SG2 findings 27 and 30.
 *
 * An unread imported-buyer ledger is not an empty ledger that a campaign may
 * use, and an unread current-subscription list is not proof that a former
 * member stayed away. Both jobs must remain retryable without sending.
 */
import { buyerLedger } from "@/lib/segments";
import {
  addProduct,
  claimHandle,
  ensureListId,
  ensureStatsId,
  setProductLink,
  setStripeAccount,
  setSubscription,
  setWinBack,
  storeForEmail,
} from "@/lib/store";
import type { Store } from "@/lib/store";
import { sendWinBacks } from "@/lib/winback-send";
import { upsertContact } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const DAY = 86_400;
const now = Date.parse("2026-11-05T08:00:00Z");
const nowSeconds = Math.floor(now / 1000);

async function importedBuyerReadEvidence(): Promise<void> {
  part("SG2(27): an unread imported-buyer ledger is not empty");
  redis.clear();
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some(([name, key]) => String(name).toUpperCase() === "HGETALL" && String(key).startsWith("nl:imp:who:"))) {
      throw new Error("synthetic imported-buyer read unavailable");
    }
    return original(commands);
  }) as typeof redis.pipeline;

  const store = {
    handle: "imported-ledger",
    statsId: "i".repeat(32),
    currency: "usd",
    pastBuyers: true,
  } as Store;
  let outcome = "resolved";
  try {
    await buyerLedger(store, async () => true);
  } catch {
    outcome = "unread";
  } finally {
    redis.pipeline = original as typeof redis.pipeline;
  }
  is("a campaign cannot use unknown imported buyers as an empty audience", outcome, "unread");
}

async function winbackReadEvidence(): Promise<void> {
  part("SG2(30): an unread current-subscription list sends nothing and stays retryable");
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_sg2_winback_read_only";
  process.env.RESEND_API_KEY = "re_test_winback_only_a_stand_in";

  const emails: unknown[] = [];
  const stripePaths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com") {
      emails.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "email_sg2_read" }));
    }
    const path = url.pathname.replace(/^\/v1/, "");
    stripePaths.push(path);
    const answer = (body: unknown) => new Response(JSON.stringify(body));
    if (path === "/events") {
      return answer({
        object: "list",
        has_more: false,
        data: [{
          id: "evt_sg2read",
          type: "customer.subscription.deleted",
          created: nowSeconds - 8 * DAY,
          data: {
            object: {
              id: "sub_Sg2Read0001",
              customer: "cus_Sg2Read0001",
              ended_at: nowSeconds - 8 * DAY,
              metadata: { store: "sg2-read", product: "pending" },
              items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] },
            },
          },
        }],
      });
    }
    if (path === "/customers/cus_Sg2Read0001") return answer({ id: "cus_Sg2Read0001", email: "reader@example.com" });
    if (path === "/subscriptions") return answer({ object: "list", has_more: false });
    return new Response(JSON.stringify({ error: { message: `no synthetic response for ${path}` } }), { status: 404 });
  }) as typeof fetch;

  const made = await claimHandle("owner-sg2@example.com", "sg2-read", "SG2 Read", "");
  if (!made.ok) throw new Error("synthetic store was not created");
  await ensureStatsId("owner-sg2@example.com");
  await ensureListId("owner-sg2@example.com");
  await setStripeAccount("owner-sg2@example.com", "acct_Sg2Read0001", true);
  await setSubscription("owner-sg2@example.com", {
    customerId: "cus_OwnerSg2Read",
    subscriptionId: "sub_OwnerSg2Read",
    active: true,
    period: paidPeriod(now),
  });
  const product = await addProduct("owner-sg2@example.com", "Pending membership", "", "29", {
    interval: "month",
    trialDays: 0,
    payments: 0,
  });
  if (!product.ok) throw new Error("synthetic product was not created");
  await setProductLink("owner-sg2@example.com", product.product.id, "https://example.test/pending");
  await setWinBack("owner-sg2@example.com", {
    percent: 25,
    months: 1,
    days: 7,
    coupon: "co_Sg2Read0001",
    address: "1 Test Street, Portland, OR 97201",
  });
  const store = await storeForEmail("owner-sg2@example.com");
  if (!store?.listId) throw new Error("synthetic list was not created");
  await upsertContact(store.listId, "reader@example.com", { agreed: true, explicit: true, source: "buyer" }, ROOM);

  // The event must name the real generated product id.
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/events") {
      return new Response(JSON.stringify({
        object: "list",
        has_more: false,
        data: [{
          id: "evt_sg2read",
          type: "customer.subscription.deleted",
          created: nowSeconds - 8 * DAY,
          data: {
            object: {
              id: "sub_Sg2Read0001",
              customer: "cus_Sg2Read0001",
              ended_at: nowSeconds - 8 * DAY,
              metadata: { store: "sg2-read", product: product.product.id },
              items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] },
            },
          },
        }],
      }));
    }
    return oldFetch(input, init);
  }) as typeof fetch;

  const result = await sendWinBacks(Date.now() + 30_000, now);
  const evidenceKeys = redis.keys().filter((key) =>
    key === "nl:wb:acct_Sg2Read0001:sub_Sg2Read0001" ||
    key.startsWith("nl:wb:once:") ||
    key.startsWith("nl:wb:link:"),
  );
  is("the worker reaches the current-subscription evidence", [result.stores, stripePaths.includes("/subscriptions")], [1, true]);
  is("unknown current subscriptions send no come-back email", [result.sent, emails.length], [0, 0]);
  is("no sent, once or link mark prevents a later confirmed retry", evidenceKeys, []);
}

async function main(): Promise<void> {
  await importedBuyerReadEvidence();
  await winbackReadEvidence();
  done();
}

void main();
