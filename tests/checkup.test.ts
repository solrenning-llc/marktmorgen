/**
 * "Something not working?", read on the server (491 [PP2], unit 2,
 * lib/checkup.ts and app/studio/checkup/page.tsx; added 1 November 2026).
 * Checked, in the in-memory Redis with Stripe and Vercel stubbed:
 *
 *   - every reader that fails or is slower than its ceiling is "not
 *     checked", never fine, and the page waits at most that long;
 *   - a domain Vercel no longer has on the project is a problem, while a
 *     Vercel that did not answer is "not checked" (the review of unit 1);
 *   - checkout refusals are "fine" only from a real count: no stats id or a
 *     failed read is "not checked";
 *   - a healthy store reads as healthy, with the two parts that have no
 *     reader yet still "not checked";
 *   - what the plan decides is said without asking anyone: a domain rests and
 *     list email is left out off Pro; email is stopped while a renewal is
 *     unpaid or a plan payment disputed (the review of unit 2);
 *   - a fix on a card the person's role cannot open is a step for the owner;
 *   - a 404 while the project's own name is wrong, or an answer without its
 *     verdicts, is "not checked", never "gone" or "records wrong";
 *   - the plan's limits (unit 3): a figure used up is a problem, otherwise
 *     fine with the most used, and unreadable is "not checked";
 *   - nothing is written: Redis holds the same keys after a checkup;
 *   - the page reads only, names each state in words, links each fix in the
 *     studio, and is one press from the studio's home; the domain card has
 *     the anchor its fix points to.
 */
import { readFileSync } from "node:fs";
import { CHECK_WAIT_MS, runCheckup, within } from "@/lib/checkup";
import { checkupSummary } from "@/lib/checkup-rules";
import { allowancesUsedStrict, takeAllowance } from "@/lib/store-allowance";
import { ALLOWANCE_KINDS, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { can } from "@/lib/team-roles";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckupList } from "@/components/checkup-list";
import { readTroubleStrict } from "@/lib/checkout-trouble";
import { domainKey } from "@/lib/domains";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 1, 12);
const read = (file: string) => readFileSync(file, "utf8");
process.env.STRIPE_SECRET_KEY = "sk_test_checkup";
process.env.VERCEL_API_TOKEN = "vercel_checkup";

type World = { stripe: "on" | "off" | "down" | "slow"; project: number; self: number; config: number; misconfigured: boolean | null };
let world: World = { stripe: "on", project: 200, self: 200, config: 200, misconfigured: false };
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  asked.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}`);
  if (url.hostname === "api.stripe.com") {
    if (world.stripe === "down") return new Response("{}", { status: 500 });
    if (world.stripe === "slow") return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ configuration: { merchant: { capabilities: { card_payments: { status: world.stripe === "on" ? "active" : "inactive" } } } }, requirements: { summary: { minimum_deadline: { status: "eventually_due" } } } }), { status: 200 });
  }
  if (url.hostname === "api.vercel.com") {
    if (/^\/v9\/projects\/[^/]+$/.test(url.pathname)) return new Response(JSON.stringify(world.self === 200 ? { id: "prj_1" } : { error: { code: "not_found" } }), { status: world.self });
    if (url.pathname.includes("/projects/")) return new Response(JSON.stringify(world.project === 200 ? { apexName: "harborkitchen.com", verified: true } : { error: { code: "not_found" } }), { status: world.project });
    return new Response(JSON.stringify(world.misconfigured === null ? {} : { misconfigured: world.misconfigured }), { status: world.config });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const SHOP = { sid: "a".repeat(32), listId: "b".repeat(32), statsId: "c".repeat(32), stripeAccountId: "acct_1Checkupxxxxxxx", domain: { name: "harborkitchen.com", liveAt: 1 }, subscriptionActive: true, tier: "pro", renewalUnpaidSince: 0, planDisputes: [] } as never;
const with_ = (over: Record<string, unknown>) => ({ ...(SHOP as object), ...over }) as never;
const OWNER = (permission: Parameters<typeof can>[1]) => can("owner", permission);
const run = (store: never = SHOP, who = OWNER, ms?: number) => runCheckup(store, who, NOW, ms);
const stateOf = (checks: { id: string; state: string }[], id: string) => checks.find((c) => c.id === id)?.state ?? "left out";

async function main(): Promise<void> {
  part("A reader that fails or is slow");
  is("failed: the fallback", await within(() => Promise.reject(new Error("no")), "fallback"), "fallback");
  const started = Date.now();
  is("slower than its ceiling: the fallback, on time", [await within(() => new Promise(() => {}), null, 50), Date.now() - started < 1_000], [null, true]);
  is("answered: the answer", await within(async () => 7, null), 7);
  is("each reader is waited for at most 8 seconds", CHECK_WAIT_MS, 8_000);

  part("A healthy store");
  await redis.pipeline([["SET", domainKey("harborkitchen.com"), "harborkitchen"]]);
  const healthy = await run();
  is("payments, domain, email, checkout and limits fine; disputes not checked", healthy.map((c) => `${c.id}:${c.state}`), ["disputes:not-checked", "stripe:ok", "checkout:ok", "domain:ok", "email:ok", "limits:ok"]);
  is("the line at the top does not say all is well", checkupSummary(healthy), "No problem found in what we checked; 1 not checked.");
  is("only reads were asked of Stripe and Vercel", asked.every((a) => a.startsWith("GET ")), true);

  part("Stripe");
  world = { ...world, stripe: "down" };
  is("Stripe failing: not checked, never fine", stateOf(await run(), "stripe"), "not-checked");
  world = { ...world, stripe: "slow" };
  const slowStart = Date.now();
  const slow = await run(SHOP, OWNER, 60);
  is("Stripe not answering: not checked, and the page does not wait for it", [stateOf(slow, "stripe"), Date.now() - slowStart < 2_000], ["not-checked", true]);
  world = { ...world, stripe: "off" };
  is("card payments off: a problem", stateOf(await run(), "stripe"), "problem");
  is("not connected: a problem, with nothing asked of Stripe", [stateOf(await run(with_({ stripeAccountId: null })), "stripe")], ["problem"]);
  world = { ...world, stripe: "on" };

  part("The domain");
  world = { ...world, project: 404 };
  const gone = (await run()).find((c) => c.id === "domain");
  is("no longer on the project: a problem, with the way to connect it again", [gone?.state, gone?.fix?.kind === "studio" && gone.fix.href], ["problem", "/studio#domain"]);
  world = { ...world, self: 404 };
  is("a 404 while the project's own name is wrong: not checked, never \"gone\"", stateOf(await run(), "domain"), "not-checked");
  world = { ...world, project: 200, self: 200 };
  world = { ...world, misconfigured: null };
  is("an answer without its verdict: not checked, not called wrong", stateOf(await run(), "domain"), "not-checked");
  world = { ...world, misconfigured: false };
  asked.length = 0;
  const resting = (await run(with_({ tier: "creator" }))).find((c) => c.id === "domain");
  is("off Pro: the domain rests, said without asking Vercel", [resting?.state, resting?.found.includes("not on Pro"), asked.some((a) => a.includes("vercel"))], ["problem", true, false]);
  world = { ...world, project: 500 };
  is("Vercel failing: not checked", stateOf(await run(), "domain"), "not-checked");
  world = { ...world, project: 200, config: 502 };
  is("the records not read: not checked, not called wrong", stateOf(await run(), "domain"), "not-checked");
  world = { ...world, config: 200, misconfigured: true };
  is("records wrong: a problem", stateOf(await run(), "domain"), "problem");
  world = { ...world, misconfigured: false };
  is("no domain of its own: left out", stateOf(await run(with_({ domain: null })), "domain"), "left out");

  part("Email and checkout");
  await redis.pipeline([["SET", `nl:mail:paused:${"a".repeat(32)}`, JSON.stringify({ reason: "bounces", until: NOW / 1000 + 86_400, sent: 300, count: 30 })]]);
  is("the list paused: a problem", stateOf(await run(), "email"), "problem");
  await redis.pipeline([["DEL", `nl:mail:paused:${"a".repeat(32)}`]]);
  await redis.pipeline([["HINCRBY", `nl:cotrouble:${"c".repeat(32)}`, "2026-10-31", 2], ["HSET", `nl:cotrouble:${"c".repeat(32)}`, "last", JSON.stringify({ at: NOW - 3_600_000, code: "x", message: "Your account cannot currently make live charges." })]]);
  is("checkout refused twice this week: a problem", stateOf(await run(), "checkout"), "problem");
  is("no stats id: refusals were never counted, so not checked", [await readTroubleStrict(null, NOW), stateOf(await run(with_({ statsId: null })), "checkout")], [null, "not-checked"]);
  const pipeline = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof pipeline }).pipeline = async () => {
    throw new Error("Redis did not answer");
  };
  const blind = await run();
  (redis as unknown as { pipeline: typeof pipeline }).pipeline = pipeline;
  is("Redis failing: email, checkout and limits not checked, never fine", [stateOf(blind, "email"), stateOf(blind, "checkout"), stateOf(blind, "limits")], ["not-checked", "not-checked", "not-checked"]);

  part("What the plan decides");
  is("off Pro there is no list email: left out", stateOf(await run(with_({ tier: "creator" })), "email"), "left out");
  const unpaid = (await run(with_({ renewalUnpaidSince: 1_700_000_000 }))).find((c) => c.id === "email");
  is("a renewal unpaid: email stopped, a problem leading to billing", [unpaid?.state, unpaid?.fix?.kind === "studio" && unpaid.fix.href], ["problem", "/studio#billing"]);
  const disputed = (await run(with_({ planDisputes: [{ id: "du_1", status: "open", at: 1, coversUntil: 2 }] }))).find((c) => c.id === "email");
  is("a plan payment disputed: email stopped, a problem", [disputed?.state, disputed?.found.includes("disputed")], ["problem", true]);
  is("with no Stripe account, checkout is left out: the payments line says no checkout can open", stateOf(await run(with_({ stripeAccountId: null })), "checkout"), "left out");

  part("A fix the role cannot open");
  world = { ...world, stripe: "off" };
  const admin = (permission: Parameters<typeof can>[1]) => can("admin", permission);
  const forAdmin = (await run(with_({ renewalUnpaidSince: 1 }), admin));
  const stripeFix = forAdmin.find((c) => c.id === "stripe")?.fix;
  const billingFix = forAdmin.find((c) => c.id === "email")?.fix;
  is("an admin, who has no payments card: asked to tell the owner, no dead link", [can("admin", "payments"), stripeFix?.kind, stripeFix?.kind === "outside" && stripeFix.where.includes("Ask the store's owner")], [false, "outside", true]);
  is("and the billing card likewise, when the role lacks it", [can("admin", "billing"), billingFix?.kind], [can("admin", "billing"), can("admin", "billing") ? "studio" : "outside"]);
  is("the owner keeps the link", (await run()).find((c) => c.id === "stripe")?.fix?.kind, "studio");
  world = { ...world, stripe: "on" };

  part("The plan's limits (unit 3)");
  await takeAllowance(SHOP, "studio", STORE_ALLOWANCES.pro.studio, NOW);
  const studioKey = redis.keys().find((k) => k.startsWith("nl:allow:studio:"))!;
  const full = (await run()).find((c) => c.id === "limits");
  is("a figure used up: a problem, in its own words, with when it opens again and a larger plan", [full?.state, full?.found.startsWith("Your studio's requests in this period are used: 5,000 studio requests."), full?.ifLeft?.includes("This opens again on "), full?.fix?.kind === "studio" && full.fix.href], ["problem", true, true, "/studio#billing"]);
  await redis.pipeline([["SET", studioKey, "1200"]]);
  is("not used up: fine, with the most used one", (await run()).find((c) => c.id === "limits")?.found, "Nothing is used up. The most used: 1,200 of 5,000 studio requests.");
  await redis.pipeline([["SET", studioKey, "not a number"]]);
  is("a count that is not a number: not checked, never nothing used", stateOf(await run(), "limits"), "not-checked");
  await redis.pipeline([["DEL", studioKey]]);
  is("strict reading: unreadable is null, never 0", [await allowancesUsedStrict({ ...(SHOP as object), sid: "", statsId: null, handle: "" } as never, ALLOWANCE_KINDS, NOW), (await allowancesUsedStrict(SHOP, ALLOWANCE_KINDS, NOW))?.every((r) => r.used === 0)], [null, true]);

  await takeAllowance(SHOP, "studio", STORE_ALLOWANCES.pro.studio, NOW);
  const noBilling = (await runCheckup(SHOP, OWNER, NOW, undefined, false)).find((c) => c.id === "limits");
  is("billing not set up here: the plan card is not drawn, so the way is said, not linked", [noBilling?.fix?.kind, noBilling?.fix?.kind === "outside" && noBilling.fix.where], ["outside", "Plans cannot be started or changed on this site just now."]);
  const editor = (permission: Parameters<typeof can>[1]) => can("editor", permission);
  is("a role without billing: asked to tell the owner", (await run(SHOP, editor)).find((c) => c.id === "limits")?.fix?.kind, "outside");
  await redis.pipeline([["DEL", redis.keys().find((k) => k.startsWith("nl:allow:studio:"))!]]);
  const trialing = with_({ trialEnds: NOW / 1000 + 5 * 86_400, sid: "d".repeat(32) });
  await takeAllowance(trialing, "studio", 7, NOW);
  is("a trial's own window: what was taken is what is read", (await allowancesUsedStrict(trialing, ALLOWANCE_KINDS, NOW))?.find((r) => r.kind === "studio"), { kind: "studio", used: 7, figure: 1_000 });
  is("a trial with room: fine", (await run(trialing)).find((c) => c.id === "limits")?.state, "ok");

  part("Nothing is written");
  const before = JSON.stringify(redis.keys().sort());
  await run();
  is("the same keys after a checkup", JSON.stringify(redis.keys().sort()), before);
  is("lib/checkup.ts sends no write", /"(SET|DEL|HSET|HINCRBY|INCR|EXPIRE)"|POST|sendEmail/.test(read("lib/checkup.ts")), false);

  part("The page");
  const page = read("app/studio/checkup/page.tsx");
  is("read with the settings permission, the role's own permissions passed on", page.includes('studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings")') && page.includes("runCheckup(store, (permission) => can(view.role, permission), checkedAt, undefined, isBillingConfigured())"), true);
  is("where you are is shown", page.includes('<nav aria-label="Breadcrumb"') && page.includes('<li aria-current="page">'), true);
  is("the page changes nothing", /fetch\(|method: "POST"|<form/.test(page), false);
  world = { ...world, stripe: "off" };
  const shown = await run(with_({ renewalUnpaidSince: 1 }));
  world = { ...world, stripe: "on" };
  const html = renderToStaticMarkup(createElement(CheckupList, { checks: shown, checkedAt: NOW, hrefOf: (href: string) => `${href}?store=x` }));
  is("each part a section named by its heading, in a list", [(html.match(/<section[^>]*aria-labelledby="check-/g) ?? []).length, html.includes("<ul")], [shown.length, true]);
  is("each state said in words, beside an icon of its own", ["Problem", "Not checked", "Fine"].every((w) => html.includes(`${w}</span>`)) && html.includes('aria-hidden="true"'), true);
  is("a fix in the studio is a link for this store", html.includes('href="/studio#stripe?store=x"'), true);
  const outside = renderToStaticMarkup(createElement(CheckupList, { checks: forAdmin, checkedAt: NOW, hrefOf: (href: string) => href }));
  is("a fix outside the person's reach says where, with no link to it", [outside.includes("How to fix it: "), outside.includes('href="/studio#stripe"')], [true, false]);
  is("when it was read is said", html.includes("Checked at 12:00 PM (UTC)."), true);
  is("the summary first, never all well while something was not checked", html.indexOf("data-checkup-summary") < html.indexOf("<ul") && !html.includes("found no problem."), true);
  const studio = read("app/studio/page.tsx");
  is("one press from the studio's home, for whoever may open it", /may\("settings"\)\s*\? \[\{ href: studioPath\(store, "", "checkup"\), title: "Something not working\?"/.test(studio), true);
  is("the domain card has the anchor its fix points to", studio.includes('<div id="domain" className="card mt-8 scroll-mt-32'), true);
  done();
}

void main();
