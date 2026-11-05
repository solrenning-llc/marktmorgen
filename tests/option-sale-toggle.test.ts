/**
 * 642 [WG2], unit 2b: the creator takes a price option off sale, or puts it
 * back, from the studio, and sees how many members are still on it. What is
 * checked, each against the real code:
 *
 *   - setOptionOnSale writes only the flag: the option keeps its id, label,
 *     price, file, link and lines, so delivery and renewals are untouched;
 *     putting it back removes the flag; doing it twice changes nothing;
 *   - an edit of an option off sale keeps it off sale;
 *   - the route takes { action: "sale", id, onSale } with onSale exactly a
 *     boolean, refuses anything else, and never calls Stripe;
 *   - { action: "count", id: product } answers how many members are on each
 *     option from the kept membership reading only (never Stripe): a number
 *     when the kept reading counted options, null when it did not, when none
 *     is kept or when the store has no Stripe account (unknown is never 0);
 *   - the product editor sends both actions and says an unknown count as a
 *     link to Memberships, never as 0.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addOption, addProduct, claimHandle, editOption, ensureStatsId, setOptionOnSale, setProductExtras, setProductLink, setStripeAccount, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { sellableOptions } from "@/lib/product-option";
import { membershipCacheKey, numbersFrom, type Sub } from "@/lib/membership-numbers";
import { POST } from "@/app/api/store/option/route";
import { membersOn, readOptionInvited, readOptionMembers } from "@/lib/option-members";
import { inviteMembers, noteKept } from "@/lib/move-members";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.STRIPE_SECRET_KEY = "sk_test_option_sale_toggle_only";

let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (String(input).includes("stripe.com")) stripeCalls += 1;
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

const OWNER = "sale.toggle@example.com";
const ORIGIN = "https://marktmorgen.com";
const post = async (session: string, body: unknown) => {
  const response = await POST(new NextRequest(`${ORIGIN}/api/store/option`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  return [response.status, (await response.json().catch(() => ({}))) as Record<string, unknown>] as const;
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "saletoggle", "Sale Toggle", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Design Club", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  for (const [label, price] of [["Basic", "10"], ["Plus", "30"]]) if (!(await addOption(OWNER, pid, label, price)).ok) throw new Error("no option");
  const read = async () => (await readProduct((await storeForEmail(OWNER))!, pid))!;
  const [basic, plus] = (await read()).options.map((o) => o.id);
  for (const id of [basic, plus]) await setProductLink(OWNER, id, `https://example.com/${id}`);
  const before = (await read()).options.find((o) => o.id === basic)!;

  part("Off sale, and back, from the store");
  is("taken off sale", (await setOptionOnSale(OWNER, basic, false)).ok, true);
  const off = (await read()).options.find((o) => o.id === basic)!;
  is("only the flag changes: id, label, price, link and lines are kept", { ...off, offSale: undefined }, { ...before, offSale: undefined });
  is("it is off sale and not offered", [off.offSale, sellableOptions((await read()) as never).map((o) => o.id)], [true, [plus]]);
  is("twice changes nothing", [(await setOptionOnSale(OWNER, basic, false)).ok, (await read()).options.find((o) => o.id === basic)!.offSale], [true, true]);
  is("an edit keeps it off sale", [(await editOption(OWNER, basic, "Basic", "12")).ok, (await read()).options.find((o) => o.id === basic)!.offSale], [true, true]);
  is("put back on sale: the flag is gone, not false", [(await setOptionOnSale(OWNER, basic, true)).ok, Object.hasOwn((await read()).options.find((o) => o.id === basic)!, "offSale")], [true, false]);
  is("an id that is no option is refused", await setOptionOnSale(OWNER, "nope123456", false), { ok: false, reason: "unknown" });

  part("The route");
  const session = await openSession(OWNER);
  is("off sale through the route", await post(session, { action: "sale", id: plus, onSale: false }), [200, { ok: true }]);
  is("it is off sale", (await read()).options.find((o) => o.id === plus)!.offSale, true);
  for (const bad of ["false", 0, null, undefined]) is(`onSale ${JSON.stringify(bad)} is refused`, (await post(session, { action: "sale", id: plus, onSale: bad }))[0], 400);
  is("an unknown option is a 404", (await post(session, { action: "sale", id: "nope123456", onSale: true }))[0], 404);
  is("back on sale through the route", [await post(session, { action: "sale", id: plus, onSale: true }), Object.hasOwn((await read()).options.find((o) => o.id === plus)!, "offSale")], [[200, { ok: true }], false]);

  part("How many are still on it, from the kept reading only");
  is("no Stripe account: unknown, never 0", await post(session, { action: "count", id: pid }), [200, { ok: true, members: { [basic]: null, [plus]: null } }]);
  await setStripeAccount(OWNER, "acct_1TestToggle01", true);
  is("nothing kept: unknown, never 0", await post(session, { action: "count", id: pid }), [200, { ok: true, members: { [basic]: null, [plus]: null } }]);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const sub = (option: string | undefined, status: string): Sub => ({ id: `sub_${status}_${option ?? "own"}`, status, product: pid, ...(option ? { option } : {}), amount: 1000, currency: "usd", interval: "month", count: 1, start: 1, ended: status === "canceled" ? 2 : 0, trialEnd: 0, channel: "direct", canceledAt: 0, cancelCause: "", feedback: "", comment: "" });
  const counted = numbersFrom([sub(basic, "active"), sub(basic, "past_due"), sub(basic, "canceled"), sub(undefined, "active")], "usd", Date.now());
  redis.run(["SET", membershipCacheKey(statsId), JSON.stringify(counted)]);
  const answered = await post(session, { action: "count", id: pid });
  is("kept reading with options counted: a number per option, 0 only when counted", answered, [200, { ok: true, members: { [basic]: 2, [plus]: 0 } }]);
  redis.run(["SET", membershipCacheKey(statsId), JSON.stringify({ ...counted, optionsCounted: undefined })]);
  is("a kept reading from before options were counted: unknown", (await post(session, { action: "count", id: pid }))[1].members, { [basic]: null, [plus]: null });
  is("an id that is no product is a 404", (await post(session, { action: "count", id: basic }))[0], 404);

  part("Invitations to move here that name each price, not yet kept (Revisor 1, C4-20261105-1945-C2-2 (2))");
  is("none sent: 0 for each, proved by the whole list", await post(session, { action: "invited", id: pid }), [200, { ok: true, invited: { [basic]: 0, [plus]: 0 } }]);
  const renews = Math.floor(Date.now() / 1000) + 20 * 86_400;
  const shop = (await storeForEmail(OWNER))!;
  await inviteMembers(shop, "job_toggle", [
    { email: "ada@example.com", productId: pid, option: basic, renews },
    { email: "ben@example.com", productId: pid, option: basic, renews },
    { email: "cy@example.com", productId: pid, option: basic, renews },
    { email: "di@example.com", productId: pid, option: plus, renews },
  ]);
  await noteKept(shop, "cy@example.com", pid);
  is("two still on their way to Basic, one to Plus; a kept one is not counted", await post(session, { action: "invited", id: pid }), [200, { ok: true, invited: { [basic]: 2, [plus]: 1 } }]);
  const invites = `nl:mv:${statsId}`;
  redis.run(["HSET", invites, "f".repeat(32) + ":broken", "not json"]);
  is("one invitation that cannot be read: unknown for every price, never 0", (await post(session, { action: "invited", id: pid }))[1].invited, { [basic]: null, [plus]: null });
  redis.run(["HDEL", invites, "f".repeat(32) + ":broken"]);
  // Replies the stand-in never gives by itself, as Upstash could: only the HVALS of the invitations is replaced.
  const realPipeline = redis.pipeline.bind(redis);
  const hostile = async (reply: () => unknown) => {
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "HVALS" ? reply() : realPipeline(commands))) as typeof redis.pipeline;
    try {
      return (await post(session, { action: "invited", id: pid }))[1].invited;
    } finally {
      redis.pipeline = realPipeline;
    }
  };
  const unknownBoth = { [basic]: null, [plus]: null };
  is("the read fails (a WRONGTYPE error, a timeout): unknown, never 0", await hostile(() => { throw new Error("Redis error: WRONGTYPE"); }), unknownBoth);
  is("a reply that is not a list: unknown", await hostile(() => ["not a list"]), unknownBoth);
  is("an envelope with an extra reply: unknown", await hostile(() => [[], []]), unknownBoth);
  is("a record behind a getter: unknown, and the getter is never called", await hostile(() => [Object.defineProperty([], "0", { enumerable: true, get: () => { throw new Error("read"); } })]), unknownBoth);
  is("an id that is no product is a 404", (await post(session, { action: "invited", id: basic }))[0], 404);
  is("the studio reads it strictly too", [readOptionInvited({ ok: true, invited: { a: 2, b: null, c: -1 } }), readOptionInvited({ ok: true, members: { a: 1 } })], [Object.assign(Object.create(null), { a: 2, b: null, c: null }), null]);
  is("Stripe was never called", stripeCalls, 0);

  part("The studio reads the count strictly: anything odd is unknown, never 0");
  is("a whole reply", readOptionMembers({ ok: true, members: { a: 3, b: 0, c: null } }), Object.assign(Object.create(null), { a: 3, b: 0, c: null }));
  is("negative, fraction, text, huge: unknown", readOptionMembers({ ok: true, members: { a: -1, b: 1.5, c: "2", d: 2 ** 60 } }), Object.assign(Object.create(null), { a: null, b: null, c: null, d: null }));
  for (const [name, raw] of [["no ok", { members: { a: 1 } }], ["ok false", { ok: false, members: { a: 1 } }], ["members a list", { ok: true, members: [1] }], ["null", null], ["a list", [{ ok: true }]], ["text", "ok"]] as const) is(`${name}: no reading`, readOptionMembers(raw), null);
  let gets = 0;
  const sneaky = { ok: true, members: Object.defineProperty({}, "a", { enumerable: true, get: () => ((gets += 1), 5) }) };
  is("a getter is never called and reads as unknown", [readOptionMembers(sneaky)?.a, gets], [null, 0]);
  is("an option the reply does not name is unknown", membersOn(readOptionMembers({ ok: true, members: { a: 1 } }), "b"), null);
  Object.defineProperty(Object.prototype, "polluted", { value: 9, configurable: true });
  is("a name inherited from Object.prototype is unknown, not 9", membersOn(readOptionMembers({ ok: true, members: {} }), "polluted"), null);
  delete (Object.prototype as Record<string, unknown>).polluted;
  is("no reading at all: unknown", membersOn(null, "a"), null);

  part("A payment plan needs no payment for a price off sale");
  const book = await addProduct(OWNER, "Plan Book", "", "30", null);
  if (!book.ok) throw new Error("no book");
  for (const [label, price] of [["Basic", "30"], ["Plus", "60"]]) if (!(await addOption(OWNER, book.product.id, label, price)).ok) throw new Error("no book option");
  const [b1, b2] = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!.options.map((o) => o.id);
  for (const id of [b1, b2]) await setProductLink(OWNER, id, `https://example.com/${id}`);
  const plan = { payments: 3, interval: "month" as const, amountCents: 2000, options: { [b2]: 2000 } };
  is("with both on sale, a plan that leaves one out is refused", (await setProductExtras(OWNER, book.product.id, { plan }) as { reason?: string }).reason, "plan_price");
  await setOptionOnSale(OWNER, b1, false);
  is("with that one off sale, the same plan is saved", (await setProductExtras(OWNER, book.product.id, { plan })).ok, true);

  part("The editor");
  const editor = readFileSync("components/product-editor.tsx", "utf8");
  is("it sends the sale action with a boolean", /action: "sale", id: option\.id, onSale: /.test(editor), true);
  is("it asks for the count of the product", /action: "count", id: product\.id/.test(editor), true);
  is("an unknown count links to Memberships instead of saying 0", /href="\/studio\/memberships"/.test(editor), true);
  is("it asks for the invitations of the product", /action: "invited", id: product\.id/.test(editor), true);
  is("it says the invitations on their way apart, and an unknown number as unknown", [/invited to move here/.test(editor), /couldn’t count the invitations/.test(editor)], [true, true]);
  const extras = readFileSync("components/checkout-extras.tsx", "utf8");
  is("the plan form asks no payment for a price off sale, and says why", [/required=\{!option\.offSale\}/.test(extras), /option\.offSale \? [^\n]*Off sale/.test(extras)], [true, true]);
  is("an empty payment for a price off sale is left out of what is sent", /filter\(\(option\) => !option\.offSale \|\| \(each\[option\.id\] \?\? ""\)\.trim\(\)\)/.test(extras), true);
  done();
}

void main();
