/**
 * 642 [WG2], Claude 5's LIGHT on #2690 (comment 6695898125): "Put back on
 * sale" asked first only from the studio's own copy of the product, and the
 * route restored without any confirmation. With a stale copy (a plan saved in
 * another tab, or by a teammate with the products role) the plan stopped for
 * every price and the toast said only "back on sale". The rule is now decided
 * on the server, under the same store lock as the write:
 *
 *   - a plain restore that would stop the plan is refused with "plan_pauses"
 *     (409) and nothing is written;
 *   - only planPauseConfirmed exactly true lets it through, and the answer
 *     says whether the plan stopped (planStopped), so the toast is true both
 *     ways;
 *   - a restore that stops nothing needs no confirmation;
 *   - the studio sends the confirmation only from its question, and opens the
 *     question when the server refuses with "plan_pauses".
 *
 * Synthetic store (redis stub), synthetic session; Stripe is never called.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductExtras, setProductLink, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { activePlan } from "@/lib/product-extras";
import { POST } from "@/app/api/store/option/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.STRIPE_SECRET_KEY = "sk_test_wg2_2690_restore_server_only";

let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  // Stripe by its host: stripe.com or one of its subdomains, never a host that only contains the name (CodeQL).
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
  if (host === "stripe.com" || host.endsWith(".stripe.com")) stripeCalls += 1;
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

const OWNER = "restore.server@example.com";
const ORIGIN = "https://marktmorgen.com";
const post = async (session: string, body: unknown) => {
  const response = await POST(new NextRequest(`${ORIGIN}/api/store/option`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  return [response.status, (await response.json().catch(() => ({}))) as Record<string, unknown>] as const;
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "restoreserver", "Restore Server", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const made = await addProduct(OWNER, "Coaching", "", "30", null);
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  for (const [label, price] of [["1 week", "30"], ["5 weeks", "150"]]) if (!(await addOption(OWNER, pid, label, price)).ok) throw new Error("no option");
  const read = async () => (await readProduct((await storeForEmail(OWNER))!, pid))!;
  const [week, five] = (await read()).options.map((o) => o.id);
  for (const id of [week, five]) await setProductLink(OWNER, id, `https://example.com/${id}`);
  const covering = { payments: 3, interval: "month" as const, amountCents: 5000, options: { [five]: 5000 } };

  part("A stale copy: the plan was saved after the studio read the product");
  is("\"1 week\" is taken off sale", (await post(session, { action: "sale", id: week, onSale: false }))[0], 200);
  const snapshot = await read();
  is("the studio's copy has no plan, so its click would not ask", activePlan(snapshot), null);
  is("another tab saves a plan for \"5 weeks\" only", (await setProductExtras(OWNER, pid, { plan: covering })).ok, true);

  part("A plain restore that would stop the plan is refused, and nothing is written");
  is("refused with plan_pauses (409)", await post(session, { action: "sale", id: week, onSale: true }), [409, { ok: false, error: "plan_pauses" }]);
  const kept = await read();
  is("\"1 week\" stays off sale and the plan stays offered", [kept.options.find((o) => o.id === week)!.offSale, activePlan(kept) !== null], [true, true]);
  is("a confirmation that is not exactly true is no confirmation", (await post(session, { action: "sale", id: week, onSale: true, planPauseConfirmed: "yes" }))[1].error, "plan_pauses");

  part("Confirmed, it goes through and says the plan stopped");
  is("confirmed restore: 200, planStopped true", await post(session, { action: "sale", id: week, onSale: true, planPauseConfirmed: true }), [200, { ok: true, planStopped: true }]);
  const restored = await read();
  is("\"1 week\" is on sale and the plan has stopped", [Object.hasOwn(restored.options.find((o) => o.id === week)!, "offSale"), activePlan(restored)], [false, null]);

  part("The reverse: a plan that covers the price needs no question, and the answer says it goes on");
  is("off sale again", (await post(session, { action: "sale", id: week, onSale: false }))[0], 200);
  is("a plan covering both prices is saved", (await setProductExtras(OWNER, pid, { plan: { ...covering, amountCents: 1000, options: { [week]: 1000, [five]: 5000 } } })).ok, true);
  is("a confirmed restore that stops nothing: planStopped false", await post(session, { action: "sale", id: week, onSale: true, planPauseConfirmed: true }), [200, { ok: true, planStopped: false }]);
  is("the plan is still offered", activePlan(await read()) !== null, true);
  is("taking a price off sale is never asked to confirm", (await post(session, { action: "sale", id: week, onSale: false }))[1], { ok: true, planStopped: false });
  is("a plain restore that stops nothing goes through", (await post(session, { action: "sale", id: week, onSale: true }))[1], { ok: true, planStopped: false });

  part("The studio");
  const editor = readFileSync("components/product-editor.tsx", "utf8").replace(/\s+/g, " ");
  is("only the question's button sends the confirmation", (editor.match(/planPauseConfirmed: true/g) ?? []).length, 1);
  is("the confirmation sits in the restore question", /restoringId === option\.id \? .*?action: "sale", id: option\.id, onSale: true, planPauseConfirmed: true/.test(editor), true);
  is("a plan_pauses refusal opens the same question", /reason === "plan_pauses"[^;]*setRestoringId\(/.test(editor), true);
  is("the toast after a confirmed restore follows the server's planStopped", /planStopped === false/.test(editor), true);
  is("Stripe is never called", stripeCalls, 0);
  done();
}

void main();
