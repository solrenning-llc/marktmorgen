/**
 * The memberships behind a member's link are read from one Stripe list
 * (lib/membership-manage.ts, subsOf), and pausing, switching tier, switching
 * to yearly and cancelling each look their membership up in it. A page that
 * is not a Stripe list in its exact shape (readStripePage: an object with its
 * own `data` list and `has_more` true or false) is not "no memberships":
 * before, it read as an empty list, so a switch said the membership was gone
 * and a pause said it could not be paused (rule 24; Claude 5, round 30). A row
 * it cannot read, or a page with more after it, leaves the list not whole, so
 * "not found" cannot be said either. Now subsOf throws, as a failed request
 * does: the page shows Stripe's own page to manage them (`cannotList`), and an
 * action ends in its error, never in "gone".
 */
import { subsOf } from "@/lib/membership-manage";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

let page: unknown = { object: "list", data: [], has_more: false };
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === "/v1/subscriptions") return new Response(JSON.stringify(page));
  throw new Error(`Unexpected synthetic endpoint ${url.pathname}`);
}) as typeof fetch;

const store = { handle: "club", previousHandles: [], releasedHandles: [] } as unknown as Store;
const grant = { a: "acct_1TestClub000001", c: "cus_Member000001", h: "club" } as Parameters<typeof subsOf>[1];
const sub = (over: Record<string, unknown> = {}) => ({ id: "sub_Member0000001", object: "subscription", status: "active", metadata: { store: "club", product: "prod000001" }, ...over });

async function outcome(): Promise<string | string[]> {
  try {
    return (await subsOf(store, grant)).map((s) => String(s.id));
  } catch {
    return "not read";
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_member_list_only_a_stand_in";

  part("A list read whole");
  page = { object: "list", data: [sub(), sub({ id: "sub_Ended00000001", status: "canceled" }), sub({ id: "sub_Other00000001", metadata: { store: "elsewhere" } })], has_more: false };
  is("the live membership of this store, only", await outcome(), ["sub_Member0000001"]);
  page = { object: "list", data: [], has_more: false };
  is("an explicit empty list is none", await outcome(), []);

  part("A page not in its shape is not 'no memberships'");
  for (const [what, value] of [
    ["no data", {}],
    ["data null", { data: null, has_more: false }],
    ["data not a list", { data: { 0: sub() }, has_more: false }],
    ["has_more missing", { data: [sub()] }],
    ["not an object", [sub()]],
  ] as [string, unknown][]) {
    page = value;
    is(`${what}: not read, never an empty list`, await outcome(), "not read");
  }

  part("A list that is not whole cannot say a membership is not there");
  page = { object: "list", data: [sub(), { id: 7, status: "active" }], has_more: false };
  is("a row it cannot read: not read", await outcome(), "not read");
  page = { object: "list", data: [sub(), sub({ id: "sub_Weird00000001", status: 4 })], has_more: false };
  is("a status it cannot read: not read", await outcome(), "not read");
  page = { object: "list", data: [sub()], has_more: true };
  is("more after this page: not read", await outcome(), "not read");

  done();
}

void main();
