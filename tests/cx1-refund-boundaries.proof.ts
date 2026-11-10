import { partsOutcome, findPlanRefund } from "@/lib/plan-refund-flow";
import { done, is, part } from "./check";
process.env.STRIPE_SECRET_KEY = "sk_test_cx1_refund_boundaries_only";
const sid = "cx1-refund-boundary";
const charges = ["ch_Cx1Boundary01", "ch_Cx1Boundary02"];
const row = { id: "re_Cx1Boundary01", charge: charges[0], amount: 123, currency: "usd", status: "succeeded", metadata: { plan_refund: sid } };
let reply: unknown = { data: [], has_more: false };
let handler: ((url: URL) => unknown) | null = null;
let writes = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if ((init?.method ?? "GET") !== "GET") { writes++; throw new Error("reader proof never writes"); }
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error("unmocked host");
  return Response.json(handler ? handler(url) : reply);
}) as typeof fetch;
async function main() {
  part("CX1 refund-page consistency and safe totals");
  for (const [name, bad] of [
    ["unknown status", { ...row, status: "new_provider_state" }],
    ["unknown owner", { ...row, metadata: { plan_refund: null } }],
    ["wrong charge", { ...row, charge: charges[1] }],
  ]) {
    reply = { data: [bad], has_more: false };
    is(String(name), (await partsOutcome(sid, [{ c: charges[0], a: 123 }])).kind, "unknown");
  }
  reply = { data: [{ ...row, amount: Number.MAX_SAFE_INTEGER }, { ...row, id: "re_Cx1Boundary02", amount: 1 }], has_more: false };
  is("sum overflow never settles", (await partsOutcome(sid, [{ c: charges[0], a: 123 }])).kind, "unknown");
  reply = { data: Array.from({ length: 101 }, (_, i) => ({ ...row, id: `re_Cx1Boundary${String(i).padStart(3, "0")}` })), has_more: false };
  is("oversized terminal page unknown", (await findPlanRefund(sid, 10000, 10100)).kind, "unknown");
  handler = url => ({ data: [{ ...row, id: url.searchParams.get("charge") === charges[1] ? "re_Cx1Boundary02" : row.id, charge: url.searchParams.get("charge"), currency: url.searchParams.get("charge") === charges[1] ? "eur" : "usd" }], has_more: false });
  is("cross-charge currency mismatch unknown", (await partsOutcome(sid, charges.map(c => ({ c, a: 123 })))).kind, "unknown");
  handler = url => url.searchParams.has("starting_after")
    ? { data: [row], has_more: false }
    : { data: [{ ...row, metadata: {} }], has_more: true };
  is("repeated id across foreign/own pages unknown", (await findPlanRefund(sid, 10000, 10100)).kind, "unknown");
  handler = null;
  reply = { data: [{ ...row, metadata: null, charge: null, status: null }], has_more: false };
  is("unrelated nullable refund remains none", (await findPlanRefund(sid, 10000, 10100)).kind, "none");
  reply = { data: [{ ...row, status: "pending" }], has_more: false };
  const pending = await partsOutcome(sid, [{ c: charges[0], a: 123 }]);
  is("pending coverage never settled", pending.kind === "found" && pending.settled, false);
  reply = { data: [row], has_more: false };
  is("genuine succeeded refund still found", (await findPlanRefund(sid, 10000, 10100)).kind, "found");
  is("no provider write", writes, 0);
  done();
}
main().catch(e => { console.error(e); process.exitCode = 1; });
