/**
 * Member and past-buyer prices (620 [SZ4]), unit 3: the studio editor.
 *
 * The creator writes "whoever holds membership X (or bought Y) pays Z% less
 * on products A and B" on their own store, for their own prices on their own
 * Stripe account. What is checked, through the real route:
 *
 *   - it is a "settings" change, as a sale and fair prices are, behind the
 *     studio's own guard (counted there), signed in only;
 *   - what is saved is exactly what was sent, or nothing: a percentage off
 *     the list, a qualifying product the store sells now (paid, not a call),
 *     a product to lower that a sale could cover, never the same product on
 *     both sides, the sizes of lib/member-price-rules.ts, no unknown field;
 *     every refusal names its field in plain words and changes nothing;
 *   - switched on only with Stripe connected; switched off keeps the rules;
 *     a rule removed is gone;
 *   - the review line says, before saving, who pays what instead of what;
 *   - the editor: labeled fields, 44px targets, the review step before
 *     saving (3.3.6), errors announced and naming the field; the studio's
 *     settings show it with no new await in the page's JSX.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { MAX_MEMBER_QUALIFYING, MAX_MEMBER_RULES, MEMBER_PERCENT_CHOICES } from "@/lib/member-price-rules";
import { MEMBER_EDIT_MESSAGES, checkMemberEdit, memberRuleLine } from "@/lib/member-price-edit";
import { memberEditChoices } from "@/lib/member-price-choices";
import { MemberPriceSection } from "@/components/member-price-section";
import { AGENT_COVERAGE } from "@/lib/agent-coverage";
import { POST as memberPriceRoute } from "@/app/api/store/member-price/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "sz4u3-owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "sz4u3", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  const club = (await addProduct(OWNER, "Kitchen Club", "", "9", { interval: "month", trialDays: 0, payments: 0 })) as { product: { id: string } };
  const guide = (await addProduct(OWNER, "Knife Guide", "", "12", null)) as { product: { id: string } };
  const planner = (await addProduct(OWNER, "Meal Planner", "", "27", null)) as { product: { id: string } };
  const tip = (await addProduct(OWNER, "Name Your Price Zine", "", "5", null, "5")) as { product: { id: string } };
  const freebie = (await addProduct(OWNER, "Free Checklist", "", "0", null)) as { product: { id: string } };
  for (const p of [guide, planner, tip, freebie]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  const [C, G, P, T, F] = [club, guide, planner, tip, freebie].map((p) => p.product.id);

  const session = await openSession(OWNER);
  const post = async (body: unknown, cookie = `${SESSION_COOKIE}=${session}`) => {
    const response = await memberPriceRoute(
      new NextRequest("https://marktmorgen.com/api/store/member-price", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }),
    );
    return { status: response.status, ...((await response.json()) as { ok?: boolean; error?: string; field?: string; rule?: number | null; message?: string; memberPrices?: unknown }) };
  };
  const saved = async () => (await storeForEmail(OWNER))!.memberPrices;
  const rule = (over: Record<string, unknown> = {}) => ({ id: "r1", percent: 20, by: [C], all: false, products: [P], ...over });

  part("What the editor can pick");
  const choices = await memberEditChoices((await storeForEmail(OWNER))!);
  is("qualifying: paid products the store sells now, memberships marked", choices.qualifying.map((q) => [q.title, q.membership]).sort(), [
    ["Kitchen Club", true],
    ["Knife Guide", false],
    ["Meal Planner", false],
    ["Name Your Price Zine", false],
  ]);
  is("to lower: only what a sale could cover, with its price", choices.discounted.map((d) => [d.title, d.priceCents]).sort(), [
    ["Knife Guide", 1200],
    ["Meal Planner", 2700],
  ]);

  part("A listing that cannot be read is not a product gone (Claude 4 team review of #3026; fixed by Claude 4 on Claude 5's behalf)");
  // The Knife Guide's listing left out of the record's first page and unreadable where it is kept: the read gives back fewer than asked.
  const whole = (await storeForEmail(OWNER))!;
  const unread = { ...whole, catalog: { ...whole.catalog, head: whole.catalog.head.filter((l) => l.id !== G) } };
  const guideKey = `nl:catalog:${whole.catalog.id}:l:${G}`;
  const kept = redis.run(["GET", guideKey]);
  is("control: read from where it is kept, every listing comes back", (await memberEditChoices(unread)).qualifying.map((q) => q.title).sort(), ["Kitchen Club", "Knife Guide", "Meal Planner", "Name Your Price Zine"]);
  redis.run(["SET", guideKey, "{not json"]);
  is("one unreadable listing: the read throws, never a list without it", await memberEditChoices(unread).then(() => "returned", (error: unknown) => (error instanceof Error ? "threw" : "rejected")), "threw");
  const shown = await MemberPriceSection({ store: unread, connected: true });
  is("so the editor shows that the products could not be read, and offers no save that would drop the rule", (shown.props as { choices: unknown }).choices, null);
  redis.run(["SET", guideKey, String(kept)]);
  is("control: readable again, the editor gets every choice", ((await MemberPriceSection({ store: unread, connected: true })).props as { choices: { qualifying: unknown[] } | null }).choices?.qualifying.length, 4);

  part("Signed in, as a settings change");
  is("signed out is refused", (await post({ on: false, rules: [] }, "")).error, "signed_out");
  const route = readFileSync("app/api/store/member-price/route.ts", "utf8");
  is("the guard asks for the settings permission, as a sale and fair prices do", /guardStoreWrite\(request, "settings"/.test(route), true);
  is("the agent only drafts it, filed under offers", [AGENT_COVERAGE["POST store/member-price"]?.area, AGENT_COVERAGE["POST store/member-price"]?.reach.kind], ["offers", "draft"]);

  part("Switched on only with Stripe connected");
  const noStripe = await post({ on: true, rules: [rule()] });
  is("refused, naming Stripe", [noStripe.status, noStripe.error, noStripe.field], [400, "stripe", "on"]);
  is("nothing saved", (await saved()).rules, []);
  is("saved off without Stripe", (await post({ on: false, rules: [rule()] })).ok, true);
  is("kept off", [(await saved()).on, (await saved()).rules.length], [false, 1]);
  await setStripeAccount(OWNER, "acct_1Sz4u3xxxxxxxxx", true);

  part("Saved exactly as sent");
  const two = [rule(), rule({ id: "r2", percent: 35, by: [G, C], all: true, products: [] })];
  const ok = await post({ on: true, rules: two });
  is("saved", [ok.status, ok.ok], [200, true]);
  is("the store holds exactly the two rules, on", await saved(), { on: true, rules: two });
  is("the reply is what was saved", ok.memberPrices, { on: true, rules: two });

  part("Each wrong part is refused, names its field and changes nothing");
  const before = JSON.stringify(await saved());
  const cases: [string, unknown, string, string, number | null][] = [
    ["a percentage off the list (0)", { on: true, rules: [rule({ percent: 0 })] }, "percent", "percent", 0],
    ["a percentage off the list (3)", { on: true, rules: [rule({ percent: 3 })] }, "percent", "percent", 0],
    ["a percentage off the list (95)", { on: true, rules: [rule({ percent: 95 })] }, "percent", "percent", 0],
    ["a percentage as text", { on: true, rules: [rule({ percent: "20" })] }, "percent", "percent", 0],
    ["no qualifying product", { on: true, rules: [rule({ by: [] })] }, "qualifying", "by", 0],
    ["a product the store does not have", { on: true, rules: [rule({ by: ["zzzzzzzz"] })] }, "qualifying", "by", 0],
    ["a free product as qualifying", { on: true, rules: [rule({ by: [F] })] }, "qualifying", "by", 0],
    ["a membership to lower", { on: true, rules: [rule({ products: [C] })] }, "products", "products", 0],
    ["a pay-what-you-want product to lower", { on: true, rules: [rule({ products: [T] })] }, "products", "products", 0],
    ["picked products with none picked", { on: true, rules: [rule({ products: [] })] }, "products", "products", 0],
    ["every product and a list too", { on: true, rules: [rule({ all: true, products: [P] })] }, "rule", "rules", 0],
    ["the same product on both sides", { on: true, rules: [rule({ by: [G], products: [G] })] }, "same", "products", 0],
    ["two rules with one name", { on: true, rules: [rule(), rule()] }, "rule", "rules", 1],
    ["a rule name in another shape", { on: true, rules: [rule({ id: "r 1" })] }, "rule", "rules", 0],
    ["a field nobody knows in a rule", { on: true, rules: [rule({ extra: 1 })] }, "unknown", "rules", 0],
    ["a field nobody knows", { on: true, rules: [rule()], admin: true }, "unknown", "form", null],
    ["on that is not yes or no", { on: "yes", rules: [rule()] }, "invalid", "on", null],
    ["rules that are not a list", { on: true, rules: {} }, "invalid", "rules", null],
    ["on with no rule", { on: true, rules: [] }, "rules_none", "rules", null],
    [`more than ${MAX_MEMBER_RULES} rules`, { on: true, rules: Array.from({ length: MAX_MEMBER_RULES + 1 }, (_, i) => rule({ id: `r${i}` })) }, "rules_many", "rules", null],
    ["the same qualifying product twice in a rule", { on: true, rules: [rule({ by: [C, C] })] }, "qualifying", "by", 0],
  ];
  for (const [what, body, error, field, index] of cases) {
    const answer = await post(body);
    is(`${what}: refused`, [answer.status, answer.ok, answer.error, answer.field, answer.rule ?? null], [400, false, error, field, index]);
    is(`${what}: says what to fix in words`, typeof answer.message === "string" && answer.message.length > 20 && answer.message === MEMBER_EDIT_MESSAGES[error], true);
  }
  is("nothing changed by any refusal", JSON.stringify(await saved()), before);

  part("Too many qualifying products across the store");
  const many = await post({ on: true, rules: [rule({ by: [C, G] }), rule({ id: "r2", by: Array.from({ length: MAX_MEMBER_QUALIFYING }, (_, i) => `q${i}xxxx`) })] });
  is("refused before reading what they are", [many.error, many.field], ["qualifying_many", "by"]);

  part("Switched off keeps the rules; a rule removed is gone");
  is("off", (await post({ on: false, rules: two })).ok, true);
  is("off, both kept", [(await saved()).on, (await saved()).rules.length], [false, 2]);
  is("one removed", (await post({ on: true, rules: [two[1]] })).ok, true);
  is("only the other is left", await saved(), { on: true, rules: [two[1]] });

  part("The review line, before saving");
  const words = { qualifying: choices.qualifying, discounted: choices.discounted };
  const at = (cents: number, percent: number) => formatMoney(cents - Math.round((cents * percent) / 100), "USD");
  is(
    "members and past buyers, picked products",
    memberRuleLine({ id: "r1", percent: 20, by: [C, G], all: false, products: [P] }, words, "USD"),
    `Members of Kitchen Club or buyers of Knife Guide will pay ${at(2700, 20)} instead of ${formatMoney(2700, "USD")} for Meal Planner.`,
  );
  is(
    "every product, with an example",
    memberRuleLine({ id: "r2", percent: 50, by: [G], all: true, products: [] }, words, "USD"),
    `Buyers of Knife Guide will pay 50% less on every product a sale can cover, now and added later. For example, ${at(2700, 50)} instead of ${formatMoney(2700, "USD")} for Meal Planner.`,
  );
  is("every percentage on the list reads back", MEMBER_PERCENT_CHOICES.every((p) => memberRuleLine({ id: "r", percent: p, by: [C], all: false, products: [P] }, words, "USD").includes(at(2700, p))), true);
  is("the browser runs the same check as the server", checkMemberEdit({ on: true, rules: [rule({ percent: 3 })] }, words, true).ok, false);

  part("The editor");
  const editor = readFileSync("components/member-price-editor.tsx", "utf8");
  is("posts to its own route", editor.includes('"/api/store/member-price"'), true);
  is("each choice has a label", editor.includes("<legend") && editor.includes("field-label") && editor.includes("htmlFor="), true);
  is("44px targets", editor.includes("min-h-11") && editor.includes("min-w-11"), true);
  is("a review step before saving, with a way back", editor.includes("Review your member prices") && editor.includes("Confirm and save") && editor.includes("Go back and change"), true);
  is("errors are announced and the server's words are shown", editor.includes('role="alert"') && editor.includes("message"), true);
  is("a rule can be removed", editor.includes("Remove this rule"), true);
  is("the same check runs before review", editor.includes("checkMemberEdit("), true);
  is("a product no longer sold is taken out on opening, said so, saved only after the review", editor.includes("rule.by.filter((id) => sold.has(id))") && editor.includes("is no longer sold"), true);

  part("In the studio's settings, with no new await in the page");
  const page = readFileSync("app/studio/page.tsx", "utf8");
  const line = page.split("\n").find((l) => l.includes("<MemberPriceSection")) ?? "";
  is("shown in the settings group", line.length > 0 && page.indexOf("<MemberPriceSection") > page.indexOf("<FairPriceEditor"), true);
  is("no await on its line", line.includes("await"), false);
  const section = readFileSync("components/member-price-section.tsx", "utf8");
  is("the section reads the choices once", (section.match(/memberEditChoices\(/g) ?? []).length, 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
