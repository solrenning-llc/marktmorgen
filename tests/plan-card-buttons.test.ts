/**
 * No button in the studio that can only be refused (534 [FQ1], unit 31;
 * added 2 November 2026). app/api/billing/switch and checkout refuse while
 * PLANS_ON_SALE is false ("billing=not-open"), so a store that already pays
 * (one from before plans closed) is shown one sentence instead of those
 * buttons, and canceling stays where the subscription can be canceled. Every
 * billing form in the studio sits behind a PLANS_ON_SALE check; every link
 * to #billing only where that card is drawn; the domain card offers Pro only
 * while plans are on sale; no email offers a switch, and the checkup no way
 * to a plan, while none is on sale.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { limitsCheck } from "@/lib/checkup-rules";
import { forBilling } from "@/lib/checkup";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const studio = flat(read("app/studio/page.tsx"));
const paid = studio.slice(studio.indexOf(") : paid ? ( <>"), studio.indexOf("Cancel the subscription </summary>"));

part("The switch refuses while no plan is on sale");
is("the route", read("app/api/billing/switch/route.ts").includes('if (!PLANS_ON_SALE) return away(origin, studio("billing=not-open"));'), true);

part("The paid plan's card");
const switches = [...paid.matchAll(/action=\{`\/api\/billing\/switch\$\{pin\}`\}/g)].length;
is("every switch of plan or cycle is drawn only while plans are on sale", [switches, (paid.match(/\{PLANS_ON_SALE && !changePending &&/g) ?? []).length, paid.indexOf(") : !PLANS_ON_SALE ? (") > 0 && paid.indexOf(") : !PLANS_ON_SALE ? (") < paid.indexOf(") : billedYearly ? (")], [6, 4, true]);
is("one sentence instead, and canceling stays only where it can be done", [paid.includes('Plans are not on sale yet, so this plan and how it is billed cannot be changed for now.${store.subscriptionId ? " You can still cancel it below." : ""}'), studio.includes("{store.subscriptionId ? ( <details className=\"mt-4\"> <summary className=\"cursor-pointer text-sm font-bold text-ink underline underline-offset-2\"> Cancel the subscription </summary>"), /PLANS_ON_SALE/.test(read("app/api/billing/cancel/route.ts")), read("app/api/billing/cancel/route.ts").includes('if (!store.subscriptionId) return away(origin, studio("billing=none"));')], [true, true, false, true]);

part("Every billing form and #billing link in the studio");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : []; });
// Outside the studio's main page, each form sits a few lines under its own PLANS_ON_SALE check.
const forms = ["app", "components"].flatMap(walk).filter((file) => file !== join("app", "studio", "page.tsx")).flatMap((file) => { const text = flat(read(file)); return [...text.matchAll(/action=\{`\/api\/billing\/(switch|checkout)/g)].map((m) => ({ file, guarded: text.slice(Math.max(0, (m.index ?? 0) - 1500), m.index).includes("PLANS_ON_SALE") })); });
is("elsewhere, each switch or checkout form has a PLANS_ON_SALE check just before it", [forms.length >= 3, forms.filter((f) => !f.guarded).map((f) => f.file)], [true, []]);
// On the main page: the paid branch's switches are checked above; every checkout form is in the branch after
// the plan card's "!PLANS_ON_SALE ? ( <> … </> )", found by matching the fragment it opens.
const closed = studio.indexOf(") : !PLANS_ON_SALE ? ( <>");
const afterNotice = (() => { let depth = 0; for (let i = closed + ") : !PLANS_ON_SALE ? ( ".length; i < studio.length; i++) { if (studio.startsWith("<>", i)) depth++; else if (studio.startsWith("</>", i)) { depth--; if (depth === 0) return i + 3; } } return -1; })();
const checkouts = [...studio.matchAll(/action=\{`\/api\/billing\/checkout/g)].map((m) => m.index ?? 0);
const switchesAll = [...studio.matchAll(/action=\{`\/api\/billing\/switch/g)].map((m) => m.index ?? 0);
is("on the main page, every checkout form only in the branch after the closed-plans notice, every switch in the paid branch", [closed > 0, studio.slice(afterNotice, afterNotice + 6), checkouts.length >= 3 && checkouts.every((at) => at > afterNotice), switchesAll.length === switches && switchesAll.every((at) => paid.includes(studio.slice(at, at + 60)))], [true, " ) : (", true, true]);
const anchors = [...studio.matchAll(/"#billing"|#billing`/g)].map((m) => studio.slice(Math.max(0, (m.index ?? 0) - 400), m.index));
is("each #billing link only where billing is set up", [anchors.length >= 3, anchors.every((before) => /billingReady|isBillingConfigured\(\)/.test(before))], [true, true]);
is("the funnels' link to the plan only where billing is set up", flat(read("app/studio/funnels/page.tsx")).includes('billingHref: can(view.role, "billing") && isBillingConfigured() ?'), true);

part("Elsewhere: the paused studio, the yearly email, the checkup");
const paused = flat(read("app/studio/paused/page.tsx"));
is("the paused studio: no move while plans are closed, cancel only with a subscription, only what works said", [paused.includes("{larger && PLANS_ON_SALE && PRO_ON_SALE && isBillingConfigured() && store.subscriptionId && mayChange ? ("), paused.includes("{paying && mayChange && isBillingConfigured() && store.subscriptionId ? ("), paused.includes('PLANS_ON_SALE ? "Changing your plan, canceling it and taking your sales with you always work." : "Canceling your plan and taking your sales with you always work."')], [true, true, true]);
is("no yearly email while plans are closed", read("lib/yearly-offer.ts").includes("if (!plansOnSale || !subscription ||"), true);
const full = [{ kind: "studio" as const, used: 300, figure: 300 }];
is("the checkup links no way to a plan while none is on sale, and its studio line names only what works", [forBilling(limitsCheck(full, "", true, false), true, false).fix, limitsCheck(full, "", true, true).fix?.kind, limitsCheck(full, "", false, false).ifLeft?.includes("changing"), read("lib/checkup.ts").includes("billingReady = true, plansOnSale = PLANS_ON_SALE")], [{ kind: "outside", where: "Plans are not on sale yet, so no plan can be started or changed for now." }, "studio", false, true]);

part("The domain card");
is("See Pro only where #billing is drawn and Pro can be had; otherwise who chooses, or that plans are closed", [studio.includes('{!may("billing") ? ( <p className="mt-5 text-sm text-ink-soft">The store&apos;s owner chooses its plan.</p> ) : !PLANS_ON_SALE || !billingReady ? ( <p className="mt-5 text-sm text-ink-soft">Paid plans are not on sale yet, so this store cannot move to Pro for now.</p> ) : ( <a href="#billing" className="btn btn-secondary mt-5">See Pro</a> )}'), studio.includes('Part of Pro, ${PLANS_ON_SALE ? "at" : "which, when plans open, is"}')], [true, true]);

done();
