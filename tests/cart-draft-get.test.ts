/**
 * The cart as it is opened (GET /api/store/cart?handle=&ids=) said the title
 * and the price of a draft (`hidden`) product to anyone who knew its 40-bit
 * id: the line came back with `ok: false`, but with its name and price in
 * the visitor's currency. Security audit 506 [SG1], MM-SA-30, the cart's GET
 * (docs/security-audit-2026-10-28.md, rule 4: a public address that shows a
 * product by its id checks `hidden` first). A draft now answers as an id the
 * store does not have: no line at all, as a deleted product does, and it is
 * never counted in the total, offered or swapped into a bundle.
 */
import { NextRequest } from "next/server";
import { GET as readCart } from "@/app/api/store/cart/route";
import { addProduct, claimHandle, ensureStatsId, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cart_draft_get";

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

type Fixture = { store: Store; draft: string; live: string };

async function shop(handle: string): Promise<Fixture> {
  const owner = `${handle}@example.test`;
  const claimed = await claimHandle(owner, handle, "Cart draft shop", "");
  if (!claimed.ok) throw new Error("fixture could not claim store");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestCartDraft1", true);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "creator", period: paidPeriod() });
  const draft = await addProduct(owner, "Secret launch plan", "Not out yet", "47", null);
  if (!draft.ok) throw new Error("fixture could not add the draft");
  await setProductLink(owner, draft.product.id, "https://example.test/secret");
  const live = await addProduct(owner, "Public guide", "Out now", "19", null);
  if (!live.ok) throw new Error("fixture could not add the live product");
  await setProductLink(owner, live.product.id, "https://example.test/guide");
  const hidden = await setProductHidden(owner, draft.product.id, true);
  if (!hidden.ok) throw new Error("fixture could not make the draft");
  const store = await storeForEmail(owner);
  if (!store) throw new Error("fixture store not found");
  return { store, draft: draft.product.id, live: live.product.id };
}

type Line = { id: string; title: string; price: string; ok: boolean };
type Answer = { status: number; text: string; items: Line[]; total?: string };

async function open(fixture: Fixture, ids: string[]): Promise<Answer> {
  const url = `https://marktmorgen.test/api/store/cart?handle=${fixture.store.handle}&ids=${ids.join(",")}`;
  const response = await readCart(new NextRequest(url, { headers: { host: "marktmorgen.test" } }));
  const text = await response.text();
  const json = JSON.parse(text) as { items?: Line[]; total?: string };
  return { status: response.status, text, items: json.items ?? [], total: json.total };
}

async function main() {
  redis.clear();
  const fixture = await shop("cartdraftget");

  part("Control: a published product is in the cart with its name and price");
  const live = await open(fixture, [fixture.live]);
  is("the cart answers", live.status, 200);
  is("the published product has its line", live.items.map((line) => line.id), [fixture.live]);
  is("with its name", live.items[0]?.title, "Public guide");
  is("and it can be paid for", live.items[0]?.ok, true);

  part("A draft is answered as an id the store does not have (MM-SA-30)");
  const draft = await open(fixture, [fixture.draft]);
  is("the cart still answers", draft.status, 200);
  is("no line for the draft", draft.items.length, 0);
  is("its title is nowhere in the answer", draft.text.includes("Secret launch plan"), false);
  is("its price is nowhere in the answer", draft.text.includes("47"), false);

  part("A draft next to a published product changes nothing for the published one");
  const both = await open(fixture, [fixture.draft, fixture.live]);
  is("only the published product has a line", both.items.map((line) => line.id), [fixture.live]);
  is("the total is the published product's alone", both.total, live.total);
  is("the draft's title is nowhere in the answer", both.text.includes("Secret launch plan"), false);

  part("An id the store does not have is answered the same way");
  const unknown = await open(fixture, ["zzzzzzzz"]);
  is("no line for an unknown id", unknown.items.length, 0);
  is("a draft and an unknown id get the same lines", JSON.stringify(draft.items), JSON.stringify(unknown.items));
  done();
}

void main().catch((error) => { console.error(error); process.exitCode = 2; });
