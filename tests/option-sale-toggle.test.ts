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
  // Stripe by its host: stripe.com or one of its subdomains, never a host that only contains the name (CodeQL).
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
  if (host === "stripe.com" || host.endsWith(".stripe.com")) stripeCalls += 1;
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
  is("off sale through the route", await post(session, { action: "sale", id: plus, onSale: false }), [200, { ok: true, planStopped: false }]);
  is("it is off sale", (await read()).options.find((o) => o.id === plus)!.offSale, true);
  for (const bad of ["false", 0, null, undefined]) is(`onSale ${JSON.stringify(bad)} is refused`, (await post(session, { action: "sale", id: plus, onSale: bad }))[0], 400);
  is("an unknown option is a 404", (await post(session, { action: "sale", id: "nope123456", onSale: true }))[0], 404);
  is("back on sale through the route", [await post(session, { action: "sale", id: plus, onSale: true }), Object.hasOwn((await read()).options.find((o) => o.id === plus)!, "offSale")], [[200, { ok: true, planStopped: false }], false]);

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

  part("Invitations counted only while they can still be used (Claude 4 on #2690)");
  const freshInvited = async () => (await post(session, { action: "invited", id: pid }))[1].invited as Record<string, number | null>;
  const before2 = (await freshInvited())[basic];
  const invitesHash = `nl:mv:${statsId}`;
  const longAgo = Math.floor(Date.now() / 1000) - 400 * 86_400;
  const staleField = "e".repeat(32) + `:${pid}`;
  redis.run(["HSET", invitesHash, staleField, JSON.stringify({ e: "old@example.com", p: pid, o: basic, r: longAgo, job: "job_old", at: longAgo, t: "a".repeat(40), kept: 0 })]);
  is("one whose link ran out long ago is not counted as on its way", (await freshInvited())[basic], before2);
  redis.run(["HSET", invitesHash, staleField, JSON.stringify({ e: "odd@example.com", p: pid, o: basic, r: Math.floor(Date.now() / 1000) + 20 * 86_400, job: "job_odd", at: Math.floor(Date.now() / 1000), t: "b".repeat(40), kept: "x" })]);
  is("one whose state cannot be read makes the count unknown, never a guess", (await freshInvited())[basic], null);
  redis.run(["HDEL", invitesHash, staleField]);

  part("A write that may not have landed is never said done (Codex Z on #2690)");
  const realPipe = redis.pipeline.bind(redis);
  // The product record's own pipeline: nothing applied, and an empty answer. Everything else as it is.
  redis.pipeline = (async (commands: (string | number)[][]) => (commands.some((c) => String(c[1] ?? "").includes(`:${plus}`) || String(c[1] ?? "").includes(`${pid}`)) && commands.length > 1 && commands.every((c) => c[0] === "SET" || c[0] === "HSET" || c[0] === "DEL") ? [] : realPipe(commands))) as typeof redis.pipeline;
  let dropped: readonly [number, Record<string, unknown>];
  try {
    dropped = await post(session, { action: "sale", id: plus, onSale: false });
  } finally {
    redis.pipeline = realPipe;
  }
  is("the studio is not told it is off sale", [dropped[0] === 200, dropped[1].ok === true], [false, false]);
  is("and the price is still offered, as it really is", sellableOptions((await read()) as never).map((o) => o.id).includes(plus), true);

  part("Every write answered as it should be, or not done (Codex T on #2690)");
  for (const [name, answer] of [["a nil for every command", (n: number) => Array.from({ length: n }, () => null)], ["an error text", (n: number) => Array.from({ length: n }, () => "ERR")], ["counts as text", (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? "OK" : "1"))]] as const) {
    redis.pipeline = (async (commands: (string | number)[][]) => (commands.length > 1 && commands.every((c) => c[0] === "SET" || c[0] === "HSET" || c[0] === "DEL") && commands.some((c) => String(c[1] ?? "").includes(pid)) ? answer(commands.length) : realPipe(commands))) as typeof redis.pipeline;
    let said: readonly [number, Record<string, unknown>];
    try {
      said = await post(session, { action: "sale", id: plus, onSale: false });
    } finally {
      redis.pipeline = realPipe;
    }
    is(`${name}: the studio is not told it is done`, [said[0] === 200, said[1].ok === true], [false, false]);
  }

  part("A list of invitations that does not match its count is unknown (Codex T on #2690)");
  const invitations = `nl:mv:${statsId}`;
  const listedNow = (redis.run(["HLEN", invitations]) as number);
  for (const [name, values] of [["an empty list for invitations that exist", () => []], ["a list shorter than the count", () => [String(redis.run(["HVALS", invitations]) && (redis.run(["HVALS", invitations]) as string[])[0])]], ["copies of one invitation as long as the count (Codex T on #2690)", () => Array.from({ length: listedNow }, () => (redis.run(["HVALS", invitations]) as string[])[0])]] as const) {
    if (listedNow < 2) break;
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "HVALS" ? [values()] : realPipe(commands))) as typeof redis.pipeline;
    let counted: readonly [number, Record<string, unknown>];
    try {
      counted = await post(session, { action: "invited", id: pid });
    } finally {
      redis.pipeline = realPipe;
    }
    is(`${name}: unknown, never a count`, counted[1].invited, { [basic]: null, [plus]: null });
  }

  part("The counts never read more than they can pay for (Codex Z on #2690)");
  const many = numbersFrom(Array.from({ length: 2000 }, (_, i) => ({ id: `sub_many${i}`, status: "active", product: pid, option: i % 2 ? basic : plus, amount: 1000, currency: "usd", interval: "month", count: 1, start: 1, ended: 0, trialEnd: 0, channel: "direct", canceledAt: 0, cancelCause: "", feedback: "", comment: "" })), "usd", Date.now());
  // What members wrote when leaving is kept with the numbers (lib/membership-numbers.ts), so a real cache runs to
  // hundreds of kilobytes (Codex Z measured 184,454 bytes): the counts are read past them, never in full.
  const wordy = { ...many, leaving: { ...(many.leaving ?? {}), comments: Array.from({ length: 300 }, (_, i) => ({ text: `comment ${i} `.padEnd(300, "x"), at: i })) } };
  redis.run(["SET", membershipCacheKey(statsId), JSON.stringify(wordy)]);
  is("the kept reading here is bigger than the bound", JSON.stringify(wordy).length > 50_000, true);
  const sizes: number[] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await realPipe(commands);
    sizes.push(new TextEncoder().encode(JSON.stringify(reply)).length);
    return reply;
  }) as typeof redis.pipeline;
  let big: readonly [number, Record<string, unknown>];
  try {
    big = await post(session, { action: "count", id: pid });
  } finally {
    redis.pipeline = realPipe;
  }
  is("a kept reading too big to pay for: unknown, never 0", big[1].members, { [basic]: null, [plus]: null });
  is("and no reply carried more than the bound", Math.max(...sizes) <= 50_000, true);
  redis.run(["DEL", membershipCacheKey(statsId)]);

  const crowd = Array.from({ length: 400 }, (_, i) => ({ email: `crowd${i}@example.com`, productId: pid, option: basic, renews }));
  await inviteMembers(shop, "job_crowd", crowd);
  sizes.length = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await realPipe(commands);
    sizes.push(new TextEncoder().encode(JSON.stringify(reply)).length);
    return reply;
  }) as typeof redis.pipeline;
  let crowded: readonly [number, Record<string, unknown>];
  try {
    crowded = await post(session, { action: "invited", id: pid });
  } finally {
    redis.pipeline = realPipe;
  }
  is("invitations too many to read within the bound: unknown, never 0", crowded[1].invited, { [basic]: null, [plus]: null });
  is("and no reply carried more than the bound", Math.max(...sizes) <= 50_000, true);
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
  // The link says what Memberships truly shows (Claude 1, reviewer C3 on #3589): the count on each price, not who.
  is("the link says Memberships shows how many are on each price, and Memberships renders that table", [/See how many members are on each price in Memberships/.test(editor), /<MembershipByPrice /.test(readFileSync("app/studio/memberships/page.tsx", "utf8"))], [true, true]);
  is("it asks for the invitations of the product", /action: "invited", id: product\.id/.test(editor), true);
  is("it never says an invitation can't be used on a price off sale: it can (Claude 4 on #2690)", /can’t be used while it is off sale/.test(editor), false);
  is("the count says it is as of the last membership reading", /still on it here \(paying, in a free trial or with a late payment\), as of your last membership reading/.test(editor), true);
  is("it says the invitations on their way apart, and an unknown number as unknown", [/invited to move here/.test(editor), /couldn’t count the invitations/.test(editor)], [true, true]);
  const extras = readFileSync("components/checkout-extras.tsx", "utf8");
  is("the plan form asks no payment for a price off sale, and says why", [/required=\{!option\.offSale\}/.test(extras), /option\.offSale \? [^\n]*Off sale/.test(extras)], [true, true]);
  is("an empty payment for a price off sale is left out of what is sent", /filter\(\(option\) => !option\.offSale \|\| \(each\[option\.id\] \?\? ""\)\.trim\(\)\)/.test(extras), true);
  done();
}

void main();
