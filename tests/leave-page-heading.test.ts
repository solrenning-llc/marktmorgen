/**
 * The page a member reaches by pressing Cancel (app/[handle]/manage/leave)
 * always has one level-one heading, also when it cannot cancel anything:
 * when the emailed link has expired, and when the membership has ended or is
 * already set to end. Without it a screen reader user who lands there from the
 * email finds no heading to start from (WCAG 1.3.1, 2.4.6, 2.4.10 AAA).
 *
 * Found walking the buyer path on main (Claude 1, 14/11/2026): axe's
 * page-has-heading-one on /@localshop/manage/leave at 320 and 1280 px.
 * Through the real page, with a synthetic store and a stand-in for Stripe.
 */
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import LeavePage from "@/app/[handle]/manage/leave/page";
import { membershipWords } from "@/lib/buyer-words/membership";
import { claimHandle, setStripeAccount } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "leave-heading@example.com";
const HANDLE = "leaveheading";
const DAY = 86_400;

/** The member's one membership as Stripe lists it: already set to end at the end of its period. */
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/subscriptions" && (init?.method ?? "GET") === "GET") {
    return answer({
      object: "list",
      has_more: false,
      data: [
        {
          id: "sub_LeaveHeading01",
          status: "active",
          customer: "cus_LeaveHeading1",
          cancel_at_period_end: true,
          metadata: { store: HANDLE, product: "club" },
          items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 20 * DAY, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
        },
      ],
    });
  }
  return answer({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

async function html(run: () => Promise<unknown>): Promise<string> {
  const node = await run();
  const stream = await renderToReadableStream(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, node as React.ReactElement), { onError: () => {} });
  await stream.allReady;
  return await new Response(stream).text();
}

const headings = (drawn: string) => [...drawn.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_leave_heading_only_a_stand_in";
  const claimed = await claimHandle(OWNER, HANDLE, "Leave Heading Studio", "A store for one test.");
  if (!claimed.ok) throw new Error(claimed.reason);
  await setStripeAccount(OWNER, "acct_1TestLeaveHead1", true);
  const m = membershipWords("en");

  const leave = (searchParams: Record<string, string>) =>
    html(() => LeavePage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve(searchParams) }));

  part("An expired or missing link: one heading, and the way to a new link");
  const expired = await leave({ token: "d".repeat(64), sub: "sub_LeaveHeading01" });
  is("one level-one heading", headings(expired).length, 1);
  is("it says the link has expired", headings(expired)[0], m.manageNotices.expired.title);
  is("the way to ask for a new link is kept", expired.includes(`href="/@${HANDLE}/manage"`), true);
  const none = await leave({});
  is("no link at all: one level-one heading too", headings(none).length, 1);

  part("A membership already set to end: one heading, and the way back to it");
  const token = "e".repeat(64);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40);
  await redis.pipeline([["SET", `nl:manage:link:${hash}`, JSON.stringify({ a: "acct_1TestLeaveHead1", c: "cus_LeaveHeading1", h: HANDLE })]]);
  const ending = await leave({ token, sub: "sub_LeaveHeading01" });
  is("the page says it cannot cancel from here", ending.includes(m.leaveGone.replace(/'/g, "&#x27;")), true);
  is("one level-one heading", headings(ending).length, 1);
  is("it names the membership", headings(ending)[0], m.yourMembership);
  is("no cancel button", ending.includes('action="/api/store/manage/cancel"'), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
