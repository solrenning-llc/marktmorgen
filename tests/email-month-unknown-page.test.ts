/**
 * #3727 (Claude 4 D / B MEDIUM): with this PR, usedThisMonth throws on a garbled
 * month counter (rule 24), and the email studio page read it in its Promise.all
 * with no catch, so the whole page fell: composer, drafts, sequences, settings.
 * The page must load, the month's count must not be guessed (no count before
 * sending), and the "This month" card must say plainly that it could not be read.
 * The real page is rendered for its owner on the in-memory store; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { isValidElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { windowId } from "@/lib/allowance-window";
import StudioEmailPage from "@/app/studio/email/page";
import { EmailStudio, MonthUsage } from "@/components/email-studio";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

globalThis.fetch = (async () => Response.json({ object: "list", data: [], has_more: false })) as typeof fetch;

let studio: Record<string, unknown> | null = null;
async function render(node: unknown): Promise<void> {
  if (node === null || typeof node !== "object") return;
  if (typeof (node as PromiseLike<unknown>).then === "function") return render(await node);
  if (Array.isArray(node)) { await Promise.all(node.map(render)); return; }
  if (!isValidElement(node)) return;
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (type === EmailStudio) studio = props;
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return render(await (type as (p: unknown) => Promise<unknown>)(props));
  await Promise.all(Object.values(props).map(render));
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "month-unknown@example.com";
  await claimHandle(OWNER, "monthunknown", "Month Unknown", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MonthUnk01", subscriptionId: "sub_MonthUnk01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const window = windowId(store);
  is("(setup) a plan month that can be told", typeof window, "string");
  await redis.pipeline([["SET", `nl:mail:used:${store.listId}:${window}`, "not-a-count"]]);
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;

  let loaded = true;
  try {
    answering(new NextRequest("https://marktmorgen.com/studio/email", { headers: { cookie } }));
    await render(await (StudioEmailPage as never as (p: unknown) => Promise<unknown>)({ searchParams: Promise.resolve({}) }));
  } catch (error) {
    loaded = false;
    console.log(error);
  } finally {
    answering(null);
  }
  is("a garbled month counter never takes the whole email studio down", loaded, true);
  is("the count is not guessed: unknown, not zero", studio ? studio.used : "absent", null);
  is("and no count before sending is offered", studio?.monthKnown, false);

  const card = renderToStaticMarkup(createElement(MonthUsage, { used: null, allowance: 7000, trial: false }));
  is("the card says the count could not be read", /could not be read/i.test(card), true);
  is("and never shows a number of emails sent", /\d+ of /.test(card), false);
  const known = renderToStaticMarkup(createElement(MonthUsage, { used: 12, allowance: 7000, trial: false }));
  is("a known count still reads as before", known.includes("12 of 7,000"), true);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
