import "./redis-stub";
import { stopRenewals } from "@/lib/closed-store-data";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cx1_renewal_only";
const handle = "cx1-renewal";
const id = "sub_Cx1Renewal01";
const store = { handle, previousHandles: [], releasedHandles: [], stripeAccountId: "acct_Cx1Renewal01" } as unknown as Store;
let metadata: unknown = {};
let deletes = 0;
let status = "active";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("unmocked host");
  if ((init?.method ?? "GET") === "DELETE") {
    deletes += 1;
    return Response.json({ id, object: "subscription", status: "canceled" });
  }
  if (!url.pathname.endsWith("/subscriptions/search")) throw new Error("unmocked path");
  return Response.json({ object: "search_result", data: [{ id, status, metadata }], has_more: false, next_page: null });
}) as typeof fetch;

async function main() {
part("CX1: missing owner metadata is unknown, never proven foreign");
for (const value of [{}, { store: null }, { store: 7 }, { store: "" }]) {
  metadata = value; deletes = 0;
  const r = await stopRenewals(store, Date.now() + 10_000);
  is(`unknown metadata ${JSON.stringify(value)} keeps the pass open`, r.done, false);
  is(`unknown metadata ${JSON.stringify(value)} never cancels an unowned row`, deletes, 0);
}
part("CX1: valid own/foreign/ended controls");
metadata = { store: handle }; deletes = 0;
let r = await stopRenewals(store, Date.now() + 10_000);
is("own live member canceled and complete", { done: r.done, stopped: r.stopped, deletes }, { done: true, stopped: 1, deletes: 1 });
metadata = { store: "other-store" }; deletes = 0;
r = await stopRenewals(store, Date.now() + 10_000);
is("proven foreign row never canceled", { done: r.done, deletes }, { done: true, deletes: 0 });
metadata = { store: handle }; status = "canceled"; deletes = 0;
r = await stopRenewals(store, Date.now() + 10_000);
is("own ended member requires no DELETE", { done: r.done, stopped: r.stopped, deletes }, { done: true, stopped: 0, deletes: 0 });
done();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
