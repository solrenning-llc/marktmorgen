/**
 * "Do this next", unit 2 (484 [IT1] complement WG): the numbers read for it (lib/next-actions-read.ts, from the
 * store's kept memberships reading, lib/store-readings.ts keptMembersCopy) and the block on Today
 * (components/next-actions-panel.tsx). The in-memory Redis stand-in; a fetch that fails if anything calls a supplier.
 * Checked:
 *
 *   - the ceiling before the read: one database command at most (the copy's GET), never Stripe, nothing for a store
 *     that sells no memberships;
 *   - a copy that cannot be read, is not in its shape or did not read every membership: each count unknown, never 0;
 *   - no copy kept: nothing read here, nothing shown, nothing said to be missing;
 *   - the members who left are asked only while the come-back email is off;
 *   - the block: a titled section, a list, each action a named link to its screen, the missing numbers said, and
 *     nothing drawn when nothing was read for this person.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextActionsPanel } from "@/components/next-actions-panel";
import { nextFactsOf } from "@/lib/next-actions-read";
import { nextActions, type NextView } from "@/lib/next-actions-rules";
import type { Numbers } from "@/lib/membership-numbers";
import { keptMembersCopy } from "@/lib/store-readings";
import type { Store } from "@/lib/store";
import { NO_WINBACK } from "@/lib/winback";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let supplierCalls = 0;
globalThis.fetch = (async () => {
  supplierCalls += 1;
  throw new Error("no supplier is called for Do this next");
}) as typeof fetch;

const AT = Date.UTC(2026, 10, 10, 6, 0, 0);
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const sells = () => true;
const shop = (statsId: string, winbackOn = false): Store =>
  ({
    statsId,
    currency: "usd",
    winback: winbackOn ? { percent: 20, months: 1, days: 7, coupon: "COMEBACK20", address: "1 Main Street, Springfield" } : { ...NO_WINBACK },
  }) as unknown as Store;
const numbers = (over: Partial<Numbers> = {}): Numbers =>
  ({ currency: "usd", mrr: 90_000, paying: 30, trialing: 0, atRisk: 3, atRiskMrr: 4_500, ended30: 2, endedMrr30: 3_000, churn30: 0.05, trialsEnded: 0, trialsConverted: 0, elsewhere: 0, byProduct: [], complete: true, at: AT, ...over }) as Numbers;
const keep = async (statsId: string, value: unknown) => {
  await redis.pipeline([["SET", `nl:reading:members:${statsId}`, typeof value === "string" ? value : JSON.stringify(value)]]);
};

/** Database commands sent while `work` runs. */
async function counted<T>(work: () => Promise<T>): Promise<{ value: T; commands: number }> {
  const real = redis.pipeline.bind(redis);
  let commands = 0;
  redis.pipeline = (async (list: (string | number)[][]) => {
    commands += list.length;
    return real(list);
  }) as typeof redis.pipeline;
  try {
    return { value: await work(), commands };
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
}

async function main(): Promise<void> {
  part("The ceiling before the read");
  {
    const none = await counted(() => nextFactsOf(shop("s-none"), { copy: keptMembersCopy, sells: () => false }));
    is("a store that sells no memberships: nothing read, nothing asked", [none.value, none.commands], [{}, 0]);
    await keep("s-read", { at: AT, value: numbers() });
    const read = await counted(() => nextFactsOf(shop("s-read"), { copy: keptMembersCopy, sells }));
    is("one database command, the copy's GET", read.commands, 1);
    is("never a supplier", supplierCalls, 0);
    is("the facts from the copy", read.value, {
      failedPayments: { count: 3, monthly: { amount: 4_500, currency: "usd" }, at: AT },
      formerMembers: { count: 2, monthly: { amount: 3_000, currency: "usd" }, at: AT },
    });
  }

  part("No copy kept: nothing read here");
  is("no copy", await nextFactsOf(shop("s-empty"), { copy: keptMembersCopy, sells }), {});
  await keep("s-null", { at: AT, value: null });
  is("a reading that found no counts", await nextFactsOf(shop("s-null"), { copy: keptMembersCopy, sells }), {});

  part("Unknown, never zero");
  const unknown = { failedPayments: { count: null, at: null }, formerMembers: { count: null, at: null } };
  await keep("s-bent", "{not json");
  is("a copy that is not JSON", await nextFactsOf(shop("s-bent"), { copy: keptMembersCopy, sells }), unknown);
  await keep("s-noat", { value: numbers() });
  is("a copy without its time", await nextFactsOf(shop("s-noat"), { copy: keptMembersCopy, sells }), unknown);
  await keep("s-part", { at: AT, value: numbers({ complete: false }) });
  is("a reading that did not read every membership counts too few: unknown", await nextFactsOf(shop("s-part"), { copy: keptMembersCopy, sells }), unknown);
  is("the database not answering", await nextFactsOf(shop("s-x"), { copy: async () => { throw new Error("down"); }, sells }), unknown);
  {
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async () => { throw new Error("down"); }) as typeof redis.pipeline;
    is("the copy's GET failing is unknown, not none", await keptMembersCopy(shop("s-read")), "unknown");
    redis.pipeline = (async () => [1, 2]) as typeof redis.pipeline;
    is("a reply of another shape is unknown", await keptMembersCopy(shop("s-read")), "unknown");
    redis.pipeline = real as typeof redis.pipeline;
  }
  await keep("s-odd", { at: AT, value: numbers({ atRisk: -2, endedMrr30: 12.5 }) });
  is("a count that is not whole: that count unknown, the rest kept", await nextFactsOf(shop("s-odd"), { copy: keptMembersCopy, sells }), {
    failedPayments: { count: null, monthly: { amount: 4_500, currency: "usd" }, at: AT },
    formerMembers: { count: 2, monthly: null, at: AT },
  });
  is("selling unknowable: nothing asked", await nextFactsOf(shop("s-read"), { copy: keptMembersCopy, sells: () => { throw new Error("bent"); } }), {});

  part("The come-back email decides whether the members who left are asked");
  is("on: not asked", await nextFactsOf(shop("s-read", true), { copy: keptMembersCopy, sells }), { failedPayments: { count: 3, monthly: { amount: 4_500, currency: "usd" }, at: AT } });
  is("on, and the copy unknown: only the failed payments unknown", await nextFactsOf(shop("s-bent", true), { copy: keptMembersCopy, sells }), { failedPayments: { count: null, at: null } });

  part("The block on Today");
  const where = { failed_payments: "/studio/memberships", winback: "#winback-title" };
  const owner = { may: () => true, where, currency: "usd", now: NOW };
  const view = nextActions(await nextFactsOf(shop("s-read"), { copy: keptMembersCopy, sells }), owner);
  const html = renderToStaticMarkup(createElement(NextActionsPanel, { view }));
  is("a section named by its heading", /<section aria-labelledby="next-actions-title"[^>]*><h2 id="next-actions-title"[^>]*>Do this next<\/h2>/.test(html), true);
  is("an ordered list, money at risk first", [...html.matchAll(/data-next-action="([a-z_]+)"/g)].map((m) => m[1]), ["failed_payments", "winback"]);
  is("the count in words", html.includes("3 members&#x27; latest payment failed, and Stripe is trying again."), true);
  is("each a link named by where it goes, to its screen", [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), [["/studio/memberships", "See your membership numbers"], ["#winback-title", "Set up the come-back email"]]);
  is("each link the size of a button (44 px, lib: .btn-sm)", (html.match(/class="btn btn-secondary btn-sm mt-3"/g) ?? []).length, 2);
  is("where each number comes from and when", html.includes("From your membership numbers, read from your Stripe account. Counted November 10, 2026 (UTC)."), true);
  is("no script, no form, no button that acts", /<script|<form|<button/.test(html), false);
  const missing: NextView = nextActions(await nextFactsOf(shop("s-bent"), { copy: keptMembersCopy, sells }), owner);
  const missingHtml = renderToStaticMarkup(createElement(NextActionsPanel, { view: missing }));
  is("numbers that could not be read are said", missingHtml.includes("Some numbers could not be read just now (failed payments and former members)"), true);
  is("and no action is drawn on them", /data-next-action=/.test(missingHtml), false);
  const zero = nextActions(await nextFactsOf(shop("s-zero-read"), { copy: async () => ({ at: AT, value: numbers({ atRisk: 0, ended30: 0 }) }), sells }), owner);
  is("all at zero: it says there is nothing to suggest", renderToStaticMarkup(createElement(NextActionsPanel, { view: zero })).includes("Nothing to suggest right now."), true);
  const quiet = nextActions({}, owner);
  is("nothing read for this person: nothing drawn", renderToStaticMarkup(createElement(NextActionsPanel, { view: quiet })), "");
  is("still no supplier called", supplierCalls, 0);
  done();
}

void main();
