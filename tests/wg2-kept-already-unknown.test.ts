/**
 * CX-123 rule 30, the same pattern as Claude 4's sweep finding (C4-20261106-2890-HOLD-175) one function over:
 * keptAlready (lib/move-members.ts) decides whether a moved member already holds the membership, so the reminder is
 * not sent. A Stripe list answered without its `data` is unknown, never "not kept": it throws, and
 * sendMoveReminders (lib/imports.ts) puts the reminder back for an hour instead of emailing someone who kept it.
 */
import { keptAlready } from "@/lib/move-members";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_kept_only_a_stand_in";
let customers: unknown = { object: "list", data: [{ id: "cus_kept000001" }], has_more: false };
let subscriptions: unknown = { object: "list", data: [{ status: "active", metadata: { product: "club000001" } }], has_more: false };
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  return new Response(JSON.stringify(url.pathname.endsWith("/customers") ? customers : subscriptions), { status: 200 });
}) as typeof fetch;

const store = { stripeAccountId: "acct_1TestKept0001" } as never;
async function ask(): Promise<boolean | "threw"> {
  try {
    return await keptAlready(store, "member@example.com", "club000001");
  } catch {
    return "threw";
  }
}

async function main(): Promise<void> {
  part("Controls");
  is("a live membership to the product: kept", await ask(), true);
  subscriptions = { object: "list", data: [], has_more: false };
  is("none: not kept", await ask(), false);
  part("A list that does not read is unknown, never \"not kept\"");
  subscriptions = { object: "list", has_more: false };
  is("the customer's subscriptions without their list", await ask(), "threw");
  subscriptions = { object: "list", data: [], has_more: false };
  customers = { object: "list" };
  is("the customers without their list", await ask(), "threw");

  // Claude 5's LEVE on #2685: a page cut short (has_more not false) is not the whole list, so "not kept" cannot be read
  // from it; a live membership found on the page read is still kept.
  part("A page cut short is not the whole list");
  customers = { object: "list", data: [{ id: "cus_kept000001" }], has_more: false };
  subscriptions = { object: "list", data: [], has_more: true };
  is("subscriptions with more not read: unknown", await ask(), "threw");
  subscriptions = { object: "list", data: [], has_more: false };
  customers = { object: "list", data: Array.from({ length: 10 }, (_, i) => ({ id: `cus_kept00000${i}` })), has_more: true };
  is("customers with more not read: unknown", await ask(), "threw");
  customers = { object: "list", data: [{ id: "cus_kept000001" }], has_more: false };
  subscriptions = { object: "list", data: [{ status: "active", metadata: { product: "club000001" } }], has_more: true };
  is("a live membership on the page read is kept, more pages or not", await ask(), true);
  done();
}

main();
