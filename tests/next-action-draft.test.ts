/**
 * "Do this next", unit 3 (484 [IT1] complement WG): the email draft written with AI only when the creator asks
 * (lib/next-action-draft-rules.ts, lib/next-action-draft.ts, app/api/store/next-actions/draft/route.ts,
 * components/next-action-draft.tsx). Synthetic stores; the model and the month's count are stand-ins here, and the
 * real path's dollar ceiling (askModel, lib/ai-spend.ts) is held by tests/ai-spend-provider.test.ts. Checked:
 *
 *   - the cost said and taken before the call: NEXT_DRAFT_JOBS from the request's own bounds at the cost table's
 *     list price; a request over its bound is refused before anything is counted;
 *   - no draft on a guess: an action not on the list now, or whose number could not be read, counts nothing and
 *     calls nothing;
 *   - the model gets no count, no amount and no person;
 *   - a draft with a made-up number, a percentage, a price, a link, "free", an offer, a promise or pressure is never
 *     shown;
 *   - nothing is saved or sent, and the screen says so.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextActionDraft } from "@/components/next-action-draft";
import { NextActionsPanel } from "@/components/next-actions-panel";
import { DRAFTABLE, MAX_DRAFT_BODY, NEXT_DRAFT_CALL, NEXT_DRAFT_JOBS, draftRequest, fitsDraftCall, isDraftable, readDraft } from "@/lib/next-action-draft-rules";
import { type DraftDeps, writeNextActionDraft } from "@/lib/next-action-draft";
import { nextActions, type NextFacts } from "@/lib/next-actions-rules";
import { WRITING_JOB_MICRO_USD, WRITING_JOB_REFERENCE, aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const AT = Date.UTC(2026, 10, 10, 6, 0, 0);
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const shop = { name: "Studio 54 Yoga", mail: { fromName: "Ana" }, statsId: "s1", sid: "s1", handle: "studio" } as unknown as Store;
const names = { storeName: "Studio 54 Yoga", creatorName: "Ana" };
const good = { subject: "About your latest payment", body: "Hi,\n\nYour latest payment for Studio 54 Yoga did not go through. Your card on file may need a look.\n\nReply to this email with any question.\n\nAna" };

part("The cost, said and taken before the call");
{
  const hold = aiRequestHoldMicroUsd(WRITING_JOB_REFERENCE.model, { inputBytes: NEXT_DRAFT_CALL.inputBytes, blocks: 1, media: null, maxTokens: NEXT_DRAFT_CALL.outputTokens });
  is("a known price at the cost table's list rates", typeof hold === "number" && hold > 0, true);
  is("the month's uses: the request's most, over the priced writing job, rounded up", NEXT_DRAFT_JOBS, Math.max(1, Math.ceil((hold as number) / WRITING_JOB_MICRO_USD)));
  is("one use", NEXT_DRAFT_JOBS, 1);
  const request = draftRequest("failed_payments", { ...names, rules: "Plain words." });
  is("the real request fits its bound", request !== null && fitsDraftCall(request), true);
  is("one twice as long does not", fitsDraftCall({ system: "x".repeat(NEXT_DRAFT_CALL.inputBytes), prompt: "y" }), false);
  is("only the failed payments are drafted", [DRAFTABLE, isDraftable("winback"), isDraftable("failed_payments"), isDraftable(3)], [["failed_payments"], false, true, false]);
  is("no instructions for an action that has none", draftRequest("winback", { ...names, rules: "" }), null);
}

part("What the model is given");
{
  const request = draftRequest("failed_payments", { ...names, rules: "RULES" })!;
  is("the names only", request.prompt, "Store: Studio 54 Yoga\nCreator: Ana");
  is("the writing rules are in", request.system.includes("RULES"), true);
  is("told not to write a number, a link, an offer or free", /Do not write any number, amount, price, percentage, date, discount, offer, gift, link, web address, or promise of a result\. Do not use the word free\./.test(request.system), true);
}

part("The check every draft passes");
is("a plain draft passes", readDraft(good, names), { ok: true, ...good });
is("a number from the store's name is fine", readDraft({ subject: "Studio 54 Yoga", body: "Hi from Studio 54 Yoga.\n\nAna" }, names).ok, true);
const refused: [string, Record<string, string>, string][] = [
  ["a made-up number", { subject: "Your payment", body: "Your 3 payments failed. Ana" }, "number"],
  ["a percentage", { subject: "Your payment", body: "Take ten percent off. Ana" }, "percentage"],
  ["a price", { subject: "Your payment", body: "Your $ payment failed. Ana" }, "price"],
  ["a link", { subject: "Your payment", body: "Go to www.example.com now. Ana" }, "link"],
  ["free", { subject: "A free month", body: "Hi. Ana" }, "free"],
  ["an offer", { subject: "Your payment", body: "Here is a coupon for you. Ana" }, "offer"],
  ["a promise", { subject: "Your payment", body: "Stay for the results. Ana" }, "promise"],
  ["pressure", { subject: "Your payment", body: "Please act now or lose access. Ana" }, "pressure"],
];
for (const [what, draft, why] of refused) is(`${what}: refused`, readDraft(draft, names), { ok: false, why });
is("a store named with a refused word is not refused for its name", readDraft({ subject: "From Free Spirit Yoga", body: "Hi from Free Spirit Yoga. Ana" }, { storeName: "Free Spirit Yoga", creatorName: "Ana" }).ok, true);
is("no subject: refused", readDraft({ subject: " ", body: "Hi" }, names), { ok: false, why: "shape" });
is("too long: refused, never cut", readDraft({ subject: "Hi", body: "a".repeat(MAX_DRAFT_BODY + 1) }, names), { ok: false, why: "shape" });
is("not an object: refused", readDraft("subject", names), { ok: false, why: "shape" });

async function main(): Promise<void> {
  part("No draft on a guess, and the order of the steps");
  const calls = { count: 0, ask: 0, jobs: 0, prompt: "", tokens: 0 };
  const deps = (facts: NextFacts, answer: string | null = JSON.stringify(good)): DraftDeps => ({
    facts: async () => facts,
    ask: async (_store, _system, prompt, maxTokens) => {
      calls.ask += 1;
      calls.prompt = prompt;
      calls.tokens = maxTokens;
      return answer;
    },
    count: (async (_store: Store, _now: number, run: () => Promise<unknown>, jobs = 1) => {
      calls.count += 1;
      calls.jobs = jobs;
      const value = await run();
      return value === null ? { ok: false, reason: "failed" } : { ok: true, value, left: 9 };
    }) as DraftDeps["count"],
  });
  const at = { failedPayments: { count: 86, monthly: { amount: 258_000, currency: "usd" }, at: AT } } satisfies NextFacts;
  is("an action with no draft", await writeNextActionDraft(shop, "winback", NOW, deps(at)), { ok: false, reason: "action" });
  is("a number not read now: no draft", await writeNextActionDraft(shop, "failed_payments", NOW, deps({ failedPayments: { count: null, at: null } })), { ok: false, reason: "unknown" });
  is("at zero now: nothing to write about", await writeNextActionDraft(shop, "failed_payments", NOW, deps({ failedPayments: { count: 0, at: AT } })), { ok: false, reason: "gone" });
  is("not on the list now: nothing to write about", await writeNextActionDraft(shop, "failed_payments", NOW, deps({})), { ok: false, reason: "gone" });
  is("none of these counted or asked anything", [calls.count, calls.ask], [0, 0]);
  const written = await writeNextActionDraft(shop, "failed_payments", NOW, deps(at));
  is("on the list: the draft", written, { ok: true, value: good, left: 9 });
  is("counted once, at NEXT_DRAFT_JOBS, then asked once at its output bound", [calls.count, calls.jobs, calls.ask, calls.tokens], [1, NEXT_DRAFT_JOBS, 1, NEXT_DRAFT_CALL.outputTokens]);
  is("the model was given no count and no amount", /86|2,?580|258/.test(calls.prompt), false);
  const bent = await writeNextActionDraft(shop, "failed_payments", NOW, deps(at, JSON.stringify({ subject: "Your payment", body: "Get 20% off if you pay today. Ana" })));
  is("a draft that fails the check is not shown", bent, { ok: false, reason: "failed" });
  is("an answer that is not JSON is not shown", await writeNextActionDraft(shop, "failed_payments", NOW, deps(at, "Sure! Here it is")), { ok: false, reason: "failed" });

  part("The real path: the store's month and its dollar ceiling");
  const source = readFileSync("lib/next-action-draft.ts", "utf8");
  is("the month's uses are taken by counted, before the call", /count: counted,/.test(source) && /deps\.count\(\s*store,\s*now,/.test(source), true);
  is("the call is askModel, which reserves its ceiling before the fetch", /askModel\(store, system, prompt, maxTokens, writingModel\(\)\)/.test(source), true);
  const route = readFileSync("app/api/store/next-actions/draft/route.ts", "utf8");
  is("the route needs drafts, and the action's own permissions", /guardStoreWrite\(request, "draft"/.test(route) && /NEXT_ACTION_NEEDS\[action\]\.every/.test(route), true);
  is("paced with the rest of the writing help", /withinEssentialLimit\("ai", store\.sid \|\| store\.handle, AI_PER_MINUTE, 60\)/.test(route), true);
  is("it saves and sends nothing", /saveDraft|sendBroadcast|sendEmail|redisPipeline/.test(route + source), false);

  part("The screen");
  const button = renderToStaticMarkup(createElement(NextActionDraft, { action: "failed_payments", jobs: NEXT_DRAFT_JOBS }));
  is("a button that says what it does", />Write a draft with AI</.test(button), true);
  is("its cost and that nothing is sent, said beside it", button.includes("Uses one of your store&#x27;s AI uses this month. Nothing is sent: you read it, change it and send it yourself."), true);
  is("the button is described by that line", /aria-describedby="([^"]+)-cost"/.test(button), true);
  is("a polite live region for the outcome", /role="status" aria-live="polite"/.test(button), true);
  const view = nextActions({ ...at, formerMembers: { count: 2, at: AT } }, { may: () => true, where: { failed_payments: "/studio/memberships", winback: "#winback-title" }, currency: "usd", now: NOW });
  const withDraft = renderToStaticMarkup(createElement(NextActionsPanel, { view, draftable: DRAFTABLE, jobs: NEXT_DRAFT_JOBS }));
  is("only the failed payments get the button", (withDraft.match(/Write a draft with AI/g) ?? []).length, 1);
  is("not where the studio does not allow it", /Write a draft with AI/.test(renderToStaticMarkup(createElement(NextActionsPanel, { view }))), false);
  is("no free, no percentage on the screen", /\bfree\b|%/i.test(withDraft), false);
  done();
}

void main();
