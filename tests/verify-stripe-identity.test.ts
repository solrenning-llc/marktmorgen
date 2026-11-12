/**
 * Rule 30 for the daily Stripe check (lib/verify-stripe.ts, verifyTiers): a
 * subscription read back by its id proves the switch only when the reply is
 * that very subscription. A reply for another subscription, or with no id at
 * all, is never counted as the check passing. The same holds for the replies
 * to the switch itself and to the void of a declined switch's invoice (POST):
 * a switch that answers as another subscription, with no id, or without the
 * price just written proves nothing, and no invoice is voided on such a reply.
 * Synthetic stand-in Stripe only:
 * nothing leaves this process.
 */
import { verifyTiers } from "@/lib/verify-stripe";
import { done, is, part } from "./check";

process.env.STRIPE_DEMO_SECRET_KEY = "sk_test_verify_stripe_identity_only";

type Sub = { id: string; customer: string; status: string; metadata: Record<string, string>; items: { data: { id: string; price: { id: string; metadata: Record<string, string> } }[] } };
const prices = new Map<string, { id: string; metadata: Record<string, string> }>();
const subs = new Map<string, Sub>();
const failing = new Set<string>();
/** What each GET /subscriptions/:id answers with: its own id, another subscription's, none, or a JSON body `null`. */
let readAs: "own" | "other" | "none" | "null" = "own";
/** What each POST /subscriptions/:id (the switch) answers with: itself, another's id, none, or itself without the price just written. */
let switchAs: "own" | "other" | "none" | "unwritten" | "null" = "own";
/** What the void of a declined switch's invoice answers with. */
let voidAs: "own" | "other" | "none" | "null" = "own";
/** The invoices a void was asked for. */
const voids: string[] = [];
const answerAs = (row: Record<string, unknown>, as: string, other: string) => {
  const copy = { ...row };
  if (as === "other") copy.id = other;
  if (as === "none") delete copy.id;
  return copy;
};

const fields = (body: URLSearchParams, prefix: string) =>
  Object.fromEntries([...body].filter(([k]) => k.startsWith(`${prefix}[`)).map(([k, v]) => [k.slice(prefix.length + 1, -1), v]));

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected request to ${url.hostname}`);
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  if (method === "POST" && path === "/prices") {
    const id = `price_Verify${prices.size}0000`;
    prices.set(id, { id, metadata: fields(body, "metadata") });
    return json({ id });
  }
  if (method === "POST" && path === "/customers") return json({ id: `cus_Verify${subs.size}${failing.size}0000` });
  if (method === "POST" && path === "/subscriptions") {
    const id = `sub_Verify${subs.size}00000`;
    const price = prices.get(body.get("items[0][price]") ?? "")!;
    const sub: Sub = { id, customer: body.get("customer") ?? "", status: "active", metadata: fields(body, "metadata"), items: { data: [{ id: `si_Verify${subs.size}0000`, price }] } };
    subs.set(id, sub);
    return json(sub);
  }
  if (method === "POST" && path === "/invoices/create_preview") return json({ total: 0, lines: { data: [] } });
  const pm = path.match(/^\/payment_methods\/(\w+)\/attach$/);
  if (method === "POST" && pm) return json({ id: "pm_VerifyFails0001" });
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (method === "POST" && customer) {
    if (body.get("invoice_settings[default_payment_method]") === "pm_VerifyFails0001") failing.add(customer[1]);
    return json({ id: customer[1] });
  }
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "POST") {
    const row = subs.get(sub[1])!;
    if (switchAs === "null") {
      // Applied (or declined) at Stripe, answered with a JSON body `null`.
      if (!failing.has(row.customer)) row.items.data[0].price = prices.get(body.get("items[0][price]") ?? "")!;
      return json(null);
    }
    if (failing.has(row.customer)) return json(answerAs({ ...row, pending_update: { expires_at: 1 }, latest_invoice: { id: "in_VerifyDeclined1", status: "open", total: 2000, amount_paid: 0 } }, switchAs, "sub_SomebodyElse02"));
    const before = row.items.data[0].price;
    row.items.data[0].price = prices.get(body.get("items[0][price]") ?? "")!;
    const items = switchAs === "unwritten" ? { data: [{ ...row.items.data[0], price: before }] } : row.items;
    return json(answerAs({ ...row, items, pending_update: null, latest_invoice: { id: "in_VerifySwitched1", status: "paid", total: 0, amount_paid: 0 } }, switchAs, "sub_SomebodyElse02"));
  }
  if (sub && method === "GET") {
    if (readAs === "null") return json(null);
    const row: Record<string, unknown> = { ...subs.get(sub[1])! };
    if (readAs === "other") row.id = "sub_SomebodyElse01";
    if (readAs === "none") delete row.id;
    return json(row);
  }
  if (sub && method === "DELETE") return json({ id: sub[1], status: "canceled" });
  const voided = path.match(/^\/invoices\/(in_\w+)\/void$/);
  if (method === "POST" && voided) {
    voids.push(voided[1]);
    if (voidAs === "null") return json(null);
    return json(answerAs({ id: voided[1], status: "void" }, voidAs, "in_SomebodyElse01"));
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** The checks that rest on reading a subscription back by its id. */
const readBack = (checks: { check: string; ok: boolean }[]) =>
  checks.filter((c) => c.check.endsWith("every door now reads the new tier") || c.check === "a declined card changes nothing, and its invoice is voided").map((c) => c.ok);

async function main(): Promise<void> {
  part("Control: each subscription read back as itself");
  readAs = "own";
  is("the three switches and the declined card pass on their own replies", readBack(await verifyTiers()), [true, true, true, true]);

  for (const [mode, label] of [["other", "another subscription's id"], ["none", "no id"]] as const) {
    part(`Read back with ${label}`);
    subs.clear();
    failing.clear();
    readAs = mode;
    is(`no check passes on a reply with ${label}`, readBack(await verifyTiers()), [false, false, false, false]);
  }

  // Claude 6 on #3098: an HTTP 200 whose JSON body is `null` itself. Whether the run fails whole (the cron then reports
  // "the run itself" as failing) or check by check, no read-back check may pass on it.
  part("Read back with a null body");
  subs.clear();
  failing.clear();
  readAs = "null";
  is("no check passes on a null body", await verifyTiers().then((checks) => readBack(checks).filter(Boolean).length, () => 0), 0);
  subs.clear();
  failing.clear();
  const named = await verifyTiers();
  is(
    "…and the run completes, each read-back failing by name rather than the whole run failing",
    [readBack(named), named.filter((c) => !c.ok).every((c) => c.detail.startsWith("Stripe's reply was not sub_"))],
    [[false, false, false, false], true],
  );
  readAs = "own";

  /** The checks that rest on the switch's own reply: the amount it charged, and the declined card. */
  const amounts = (checks: { check: string; ok: boolean }[]) => checks.filter((c) => c.check.endsWith("the amount the member page shows is what Stripe charges")).map((c) => c.ok);
  const declined = (checks: { check: string; ok: boolean }[]) => checks.find((c) => c.check === "a declined card changes nothing, and its invoice is voided")?.ok;
  const run = async (switching: typeof switchAs, voiding: typeof voidAs) => {
    subs.clear();
    failing.clear();
    voids.length = 0;
    readAs = "own";
    switchAs = switching;
    voidAs = voiding;
    const checks = await verifyTiers();
    return [amounts(checks), declined(checks), [...voids]];
  };

  part("Control: the switch and the void answer as themselves");
  is("the three amounts and the declined card pass, and the declined switch's invoice is voided", await run("own", "own"), [[true, true, true], true, ["in_VerifyDeclined1"]]);

  for (const [mode, label] of [["other", "another subscription's id"], ["none", "no id"]] as const) {
    part(`The switch answered with ${label}`);
    is(`no amount and no declined card pass on it, and no invoice is voided on it`, await run(mode, "own"), [[false, false, false], false, []]);
  }
  part("The switch answered as itself but without the price just written");
  is("no amount passes on it; the declined card, answered as itself, still does", await run("unwritten", "own"), [[false, false, false], true, ["in_VerifyDeclined1"]]);

  for (const [mode, label] of [["other", "another invoice's id"], ["none", "no id"]] as const) {
    part(`The void answered with ${label}`);
    is(`the declined card never passes on it`, await run("own", mode), [[true, true, true], false, ["in_VerifyDeclined1"]]);
  }

  // Claude 6 on #3098, the same shape on the POST replies: an HTTP 200 whose JSON body is `null` itself. Whether the run
  // fails whole (the cron reports "the run itself" as failing) or check by check, nothing passes on it.
  const passingOn = (checks: { check: string; ok: boolean }[]) => [...amounts(checks), declined(checks)].filter(Boolean).length;
  /** The checks of one run, or null when the whole run failed (the cron then reports "the run itself" as failing). */
  const attempt = async (switching: typeof switchAs, voiding: typeof voidAs) => {
    subs.clear();
    failing.clear();
    voids.length = 0;
    readAs = "own";
    switchAs = switching;
    voidAs = voiding;
    return verifyTiers().then(
      (checks) => checks,
      () => null,
    );
  };
  part("The switch answered with a null body");
  const onSwitch = await attempt("null", "own");
  is("no amount and no declined card pass on it", onSwitch === null ? 0 : passingOn(onSwitch), 0);
  part("The void answered with a null body");
  const onVoid = await attempt("own", "null");
  is("the declined card never passes on it", onVoid === null ? false : declined(onVoid) === true, false);
  switchAs = "own";
  voidAs = "own";
}

main().then(done).catch((error) => {
  console.error(error);
  process.exit(1);
});
