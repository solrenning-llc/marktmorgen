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
// Each row with its id, as Stripe answers it: main's reader (readStripePage, since #4121) takes a row without one as unreadable.
let subscriptions: unknown = { object: "list", data: [{ id: "sub_kept000001", status: "active", metadata: { product: "club000001" } }], has_more: false };
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
  part("A list cut short, or that does not say whether it is whole, is unknown (Claude 4's LEVE on #2685)");
  customers = { object: "list", data: [{ id: "cus_kept000001" }], has_more: false };
  subscriptions = { object: "list", data: [], has_more: true };
  is("the subscriptions with more beyond the page", await ask(), "threw");
  subscriptions = { object: "list", data: [] };
  is("the subscriptions without has_more", await ask(), "threw");
  subscriptions = { object: "list", data: [], has_more: false };
  customers = { object: "list", data: [{ id: "cus_kept000001" }], has_more: true };
  is("the customers with more beyond the page", await ask(), "threw");
  customers = { object: "list", data: [{ id: "cus_kept000001" }] };
  is("the customers without has_more", await ask(), "threw");
  // Altered in the merge of main (16/11/2026): main's keptAlready asks Stripe for a hundred records at a time (the PR
  // asked for ten), so "more than were asked for" is now a hundred and one.
  customers = { object: "list", data: Array.from({ length: 101 }, (_, n) => ({ id: `cus_kept000${String(n).padStart(3, "0")}` })), has_more: false };
  is("more customers than were asked for", await ask(), "threw");
  part("A row that does not read is unknown, never \"not kept\" (Codex CX1's MEDIUM on #3598)");
  customers = { object: "list", data: [{ id: "cus_kept000001" }], has_more: false };
  const row = async (sub: unknown) => {
    subscriptions = { object: "list", data: [sub], has_more: false };
    return ask();
  };
  is("a status Stripe has no name for", await row({ id: "sub_kept000002", status: "not-a-stripe-status", metadata: { product: "club000001" } }), "threw");
  is("an active row with no metadata", await row({ id: "sub_kept000003", status: "active" }), "threw");
  is("an active row with null metadata", await row({ id: "sub_kept000004", status: "active", metadata: null }), "threw");
  is("an active row with a numeric product", await row({ id: "sub_kept000005", status: "active", metadata: { product: 17 } }), "threw");
  is("a row that is not an object", await row("sub_kept000001"), "threw");
  subscriptions = { object: "list", data: [], has_more: false };
  customers = { object: "list", data: [{ object: "customer" }], has_more: false };
  is("a customer row with no id", await ask(), "threw");
  part("Rows that read, of another kind: not kept");
  customers = { object: "list", data: [{ id: "cus_kept000001" }], has_more: false };
  is("a canceled membership to the product", await row({ id: "sub_kept000006", status: "canceled", metadata: { product: "club000001" } }), false);
  is("a live membership to another product", await row({ id: "sub_kept000007", status: "active", metadata: { product: "other000001" } }), false);
  is("a live row with empty metadata", await row({ id: "sub_kept000008", status: "active", metadata: {} }), false);
  part("Controls, still");
  customers = { object: "list", data: [{ id: "cus_kept000001" }], has_more: false };
  subscriptions = { object: "list", data: [{ id: "sub_kept000001", status: "active", metadata: { product: "club000001" } }], has_more: false };
  is("a whole list with a live membership: kept", await ask(), true);
  done();
}

main();
