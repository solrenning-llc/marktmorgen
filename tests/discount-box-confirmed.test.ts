/**
 * The checkout's code box (lib/store.ts, hasDiscounts) and the codes on the
 * creator's Stripe account must agree before anything is said as done: a live
 * code with the box off is a code no buyer can enter. The sibling of the
 * scheduled-code fix (#3006, rule 30): the studio's discount route and
 * /api/v1/codes read setHasDiscounts' answer exactly, and a write that throws,
 * finds no store or comes back with anything but the box asked for is never
 * answered as success while a code is live. A synthetic Stripe and the
 * in-memory Redis; nothing leaves this machine.
 */
import { NextRequest } from "next/server";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { POST as studioRoute } from "@/app/api/store/discount/route";
import { POST as apiMake, DELETE as apiStop } from "@/app/api/v1/codes/route";
import { makeKey } from "@/lib/api-keys";
import { boxIs, boxSwitchedOn, setDiscountBox } from "@/lib/discount-box";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, setHasDiscounts, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "discount-box@example.com";
const ACCOUNT = "acct_DiscountBoxTest1";
process.env.STRIPE_SECRET_KEY = "sk_test_discount_box_stand_in";

// ------------------------------------------------------------ the store write that fails, armed by a Stripe call
type Failure = "throw" | "lost";
/** How the next store writes fail, once `armAt` has been served by Stripe. */
let armed: Failure | null = null;
let armAt: "make" | "stop" | "list" | null = null;
let failing: Failure | null = null;
const realPipeline = redis.pipeline.bind(redis);
const holdsStore = (value: unknown) => typeof value === "string" && value.includes('"catalog"');
redis.pipeline = (async (commands: (string | number)[][]) => {
  // "throw": the write of the store record itself fails (the lock and the reads still work).
  if (failing === "throw" && commands.some((command) => command.slice(1).some((arg) => typeof arg === "string" && arg.includes('"hasDiscounts"')))) {
    throw new Error("synthetic: the store record could not be written");
  }
  const replies = await realPipeline(commands);
  // "lost": the store reads back as no store at all.
  return failing === "lost" ? replies.map((reply) => (holdsStore(reply) ? null : reply)) : replies;
}) as typeof redis.pipeline;
const arm = (failure: Failure, at: "make" | "stop" | "list") => { armed = failure; armAt = at; failing = null; };
const disarm = () => { armed = null; armAt = null; failing = null; };
const served = (at: "make" | "stop" | "list") => { if (armAt === at) failing = armed; };

// ------------------------------------------------------------ a synthetic Stripe in memory
type Promo = Record<string, unknown>;
const coupons = new Map<string, Record<string, unknown>>();
const promos = new Map<string, Promo>();
let n = 0;
/** Stripe's list not answering, as after a make whose list cannot be read (claude6/r24-discount-list: answered done, listed false). */
let listDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || new Headers(init?.headers).get("Stripe-Account") !== ACCOUNT) throw new Error(`unexpected ${url}`);
  const form = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");
  if (init?.method === "GET" && url.pathname === "/v1/promotion_codes") {
    if (listDown) return Response.json({ error: { message: "synthetic outage" } }, { status: 500 });
    const answer = Response.json({ object: "list", has_more: false, data: [...promos.values()].map((p) => ({ ...p, promotion: { type: "coupon", coupon: coupons.get(String((p.promotion as { coupon: string }).coupon)) } })) });
    served("list");
    return answer;
  }
  if (init?.method === "POST" && url.pathname === "/v1/coupons") {
    const id = `co_${++n}`;
    const coupon = { id, object: "coupon", percent_off: form.get("percent_off") ? Number(form.get("percent_off")) : null, amount_off: null, currency: null, duration: "once" };
    coupons.set(id, coupon);
    return Response.json(coupon);
  }
  if (init?.method === "POST" && url.pathname === "/v1/promotion_codes") {
    const code = form.get("code") ?? "";
    if ([...promos.values()].some((p) => p.code === code && p.active)) return Response.json({ error: { type: "invalid_request_error", message: "A promotion code with this code already exists." } }, { status: 400 });
    const id = `promo_${++n}`;
    const row: Promo = { id, object: "promotion_code", code, active: true, times_redeemed: 0, max_redemptions: null, expires_at: null, restrictions: { minimum_amount: null, minimum_amount_currency: null, first_time_transaction: false }, promotion: { type: "coupon", coupon: form.get("promotion[coupon]") } };
    promos.set(id, row);
    served("make");
    return Response.json(row);
  }
  const stop = url.pathname.match(/^\/v1\/promotion_codes\/(promo_\w+)$/);
  if (init?.method === "POST" && stop) {
    const row = promos.get(stop[1]);
    if (!row) return Response.json({ error: { message: "No such promotion code" } }, { status: 404 });
    row.active = false;
    served("stop");
    return Response.json(row);
  }
  throw new Error(`unexpected ${init?.method} ${url}`);
}) as typeof fetch;

const liveCodes = () => [...promos.values()].filter((p) => p.active).map((p) => String(p.code)).sort();
const idOf = (code: string) => String([...promos.values()].find((p) => p.code === code)?.id);
const box = async () => (await storeForEmail(OWNER))?.hasDiscounts;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "discount-box-shop", "Discount Box Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_DiscBox1", subscriptionId: "sub_DiscBox1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid, "Synthetic writer", Date.now(), true);
  if (!writer.ok) throw new Error("no synthetic key");
  const session = await openSession(OWNER);
  const auth = { Authorization: `Bearer ${writer.key}`, "Content-Type": "application/json" };

  const studio = async (body: Record<string, unknown>) => {
    const r = await studioRoute(new NextRequest("https://marktmorgen.com/api/store/discount", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const make = async (code: string) => {
    const r = await apiMake(new Request("https://marktmorgen.com/api/v1/codes", { method: "POST", headers: auth, body: JSON.stringify({ code, percent: 10 }) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const switchOff = async (id: string) => {
    const r = await apiStop(new Request(`https://marktmorgen.com/api/v1/codes?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: auth }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  /** Clears Stripe and switches the box off, for the next case. */
  const fresh = async () => { disarm(); listDown = false; promos.clear(); coupons.clear(); await setHasDiscounts(OWNER, false); };

  part("POST /api/v1/codes: a code made on Stripe is not said as made while the box is not confirmed on");
  for (const failure of ["throw", "lost"] as const) {
    await fresh();
    arm(failure, "make");
    const made = await make(`APIMAKE${failure.toUpperCase()}`);
    disarm();
    is(`${failure}: not a success, said as the box`, [made.status, made.body.error], [503, "checkout_box"]);
    is(`${failure}: the words say the code is on Stripe and buyers cannot enter it yet, and how to switch it off`, [
      String(made.body.message).includes(`APIMAKE${failure.toUpperCase()}`),
      String(made.body.message).includes("buyers cannot enter it"),
      String(made.body.message).includes(`DELETE /api/v1/codes?id=${idOf(`APIMAKE${failure.toUpperCase()}`)}`),
    ], [true, true, true]);
    is(`${failure}: no Stripe call beyond the two already counted (the code stays as Stripe has it)`, liveCodes(), [`APIMAKE${failure.toUpperCase()}`]);
  }
  await fresh();
  const fine = await make("APIFINE");
  is("control: the box written and read back on, made as before", [fine.status, (fine.body.data as Record<string, unknown>)?.active, await box()], [200, true, true]);

  part("DELETE /api/v1/codes: other live codes with the box not confirmed on are not said as fine");
  for (const failure of ["throw", "lost"] as const) {
    await fresh();
    is("two live codes made", [(await make("KEEPLIVE")).status, (await make("GOOFF")).status], [200, 200]);
    await setHasDiscounts(OWNER, false); // a box left off by an earlier failure
    arm(failure, "stop");
    const stopped = await switchOff(idOf("GOOFF"));
    disarm();
    is(`${failure}: not a success, said as the box`, [stopped.status, stopped.body.error], [503, "checkout_box"]);
    is(`${failure}: the words say the switch-off was done and the other codes cannot be entered yet`, [String(stopped.body.message).includes("was switched off"), String(stopped.body.message).includes("buyers cannot enter them")], [true, true]);
    is(`${failure}: Stripe has it off, the other still live`, liveCodes(), ["KEEPLIVE"]);
  }
  await fresh();
  await make("LASTONE");
  arm("throw", "stop");
  const last = await switchOff(idOf("LASTONE"));
  disarm();
  is("the last live code switched off while the box cannot be written: said as done, from what Stripe says, never 'could not be read'", [last.status, Array.isArray(last.body.data) && !(last.body.data as Record<string, unknown>[]).some((c) => c.active)], [200, true]);
  await fresh();
  await make("STAYS");
  await make("OFFNOW");
  arm("throw", "stop");
  const boxAlreadyOn = await switchOff(idOf("OFFNOW"));
  disarm();
  is("control: the box already on needs no write, so a store that cannot be written changes nothing", [boxAlreadyOn.status, await box()], [200, true]);

  part("The studio: adding, listing and stopping never answer the codes as fine with the box not confirmed on");
  for (const failure of ["throw", "lost"] as const) {
    await fresh();
    arm(failure, "make");
    const added = await studio({ action: "add", code: `STUDIOADD${failure.toUpperCase()}`, percent: "10" });
    disarm();
    is(`add, ${failure}: not ok, said as the box`, [added.status, added.body.ok, added.body.error, "codes" in added.body], [503, false, "checkout_box", false]);
    await fresh();
    promos.set("promo_live", { id: "promo_live", object: "promotion_code", code: "ALREADYLIVE", active: true, times_redeemed: 0, max_redemptions: null, expires_at: null, restrictions: { minimum_amount: null, minimum_amount_currency: null, first_time_transaction: false }, promotion: { type: "coupon", coupon: "co_none" } });
    coupons.set("co_none", { id: "co_none", object: "coupon", percent_off: 5, amount_off: null, currency: null, duration: "once" });
    arm(failure, "list");
    const listed = await studio({ action: "list" });
    disarm();
    is(`list, ${failure}: a live code with the box not confirmed on is not shown as fine`, [listed.status, listed.body.ok, listed.body.error], [503, false, "checkout_box"]);
  }
  for (const failure of ["throw", "lost"] as const) {
    await fresh();
    arm(failure, "make");
    listDown = true;
    const unlisted = await studio({ action: "add", code: `UNLISTED${failure.toUpperCase()}`, percent: "10" });
    disarm();
    listDown = false;
    is(`add, ${failure}, the list after it unreadable: never 'done' on a box not confirmed on`, [unlisted.status, unlisted.body.ok, unlisted.body.error, unlisted.body.done], [503, false, "checkout_box", undefined]);
  }
  await fresh();
  listDown = true;
  const doneUnlisted = await studio({ action: "add", code: "DONEUNLISTED", percent: "10" });
  listDown = false;
  is("control (claude6/r24-discount-list kept): box confirmed on, list unreadable: said as done, listed false", [doneUnlisted.status, doneUnlisted.body.ok, doneUnlisted.body.done, doneUnlisted.body.listed, await box()], [200, true, "add", false, true]);
  await fresh();
  await studio({ action: "add", code: "STUDIOLAST", percent: "10" });
  arm("throw", "stop");
  const studioStop = await studio({ action: "stop", id: idOf("STUDIOLAST") });
  disarm();
  is("stop of the last live code while the box cannot be written: said as done, the list as Stripe has it", [studioStop.status, studioStop.body.ok, Array.isArray(studioStop.body.codes)], [200, true, true]);
  await fresh();
  const studioFine = await studio({ action: "add", code: "STUDIOFINE", percent: "10" });
  is("control: added as before, box on", [studioFine.status, studioFine.body.ok, await box()], [200, true, true]);

  part("The box is read exactly; a write that throws is not confirmed");
  is("only `true` is on", [boxSwitchedOn({ hasDiscounts: true }), boxSwitchedOn(null), boxSwitchedOn(undefined), boxSwitchedOn({ hasDiscounts: false }), boxSwitchedOn({ hasDiscounts: "true" as unknown as boolean }), boxSwitchedOn({ hasDiscounts: 1 as unknown as boolean })], [true, false, false, false, false, false]);
  is("only `false` is off", [boxIs({ hasDiscounts: false }, false), boxIs(null, false), boxIs({ hasDiscounts: undefined as unknown as boolean }, false), boxIs({ hasDiscounts: 0 as unknown as boolean }, false)], [true, false, false, false]);
  await fresh();
  failing = "throw";
  const thrown = await setDiscountBox(OWNER, true);
  failing = null;
  is("a store write that throws: not confirmed, and the box as it was", [thrown, await box()], [false, false]);
  is("a store that is not there: not confirmed", await setDiscountBox("nobody-here@example.com", true), false);
  is("written and read back: confirmed", [await setDiscountBox(OWNER, true), await box()], [true, true]);

  part("No route writes the box without reading its answer (rule 30)");
  const walk = (dir: string): string[] => readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []));
  const direct = walk("app").filter((file) => /\bsetHasDiscounts\s*\(/.test(readFileSync(join(process.cwd(), file), "utf8")));
  is("every route goes through lib/discount-box.ts", direct, []);

  part("The words, for the creator and in the API reference");
  const root = process.cwd();
  const editor = readFileSync(join(root, "components/discount-editor.tsx"), "utf8");
  is("the studio has its own words for the box", /checkout_box:\s*\n?\s*"[^"]*buyers cannot enter/.test(editor), true);
  const reference = readFileSync(join(root, "app/developers/page.tsx"), "utf8");
  is("the API reference names the answer", reference.includes("checkout_box"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
