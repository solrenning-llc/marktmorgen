/**
 * #4504: the page a member reaches by pressing Cancel
 * (app/[handle]/manage/leave/page.tsx) has exactly one level-one heading in
 * every state, as /@handle/manage does (WCAG 1.3.1, 2.4.6, 2.4.10): with no
 * link, with a link that expired, with a membership already set to end, and
 * with one that can still be canceled.
 *
 * Through the real page, with a synthetic store and a stand-in for Stripe.
 */
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import LeavePage from "@/app/[handle]/manage/leave/page";
import { membershipWords } from "@/lib/buyer-words/membership";
import { claimHandle, ensureStatsId, setStripeAccount } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "leave-heading@example.com";
const HANDLE = "leaveheading";
const ACCOUNT = "acct_1TestLeaveHead1";
const DAY = 86_400;

// Whether the member's one membership is already set to end.
let ending = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/subscriptions" && method === "GET") {
    const end = Math.floor(Date.now() / 1000) + 20 * DAY;
    return answer({
      object: "list",
      has_more: false,
      data: [
        {
          id: "sub_LeaveHead0001",
          status: "active",
          customer: "cus_LeaveHead001",
          metadata: { store: HANDLE },
          cancel_at_period_end: ending,
          items: { data: [{ current_period_end: end, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
        },
      ],
    });
  }
  if (path === "/checkout/sessions" && method === "GET") return answer({ object: "list", has_more: false, data: [] });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function html(search: Record<string, string>): Promise<string> {
  const node = await LeavePage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve(search) });
  const stream = await renderToReadableStream(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, node as React.ReactElement), { onError: () => {} });
  await stream.allReady;
  return await new Response(stream).text();
}

/** The text of each level-one heading on the page. */
const headings = (drawn: string) => [...drawn.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((h) => h[1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'"));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_leave_heading_only_a_stand_in";
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Clay House", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);

  const m = membershipWords("en");
  const token = "d".repeat(64);
  const hash = createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40);
  await redis.pipeline([["SET", `nl:manage:link:${hash}`, JSON.stringify({ a: ACCOUNT, c: "cus_LeaveHead001", h: HANDLE })]]);
  const sub = "sub_LeaveHead0001";

  part("No link, or a link that expired: the heading says so");
  is("no link: one h1, the expired title", headings(await html({})), [m.manageNotices.expired.title]);
  is("an expired link: one h1, the expired title", headings(await html({ token: "e".repeat(64), sub })), [m.manageNotices.expired.title]);

  part("A membership already set to end: one heading above the sentence");
  ending = true;
  const gone = await html({ token, sub });
  is("one h1, Your membership", headings(gone), [m.yourMembership]);
  is("the sentence and the way on kept", [gone.includes(m.leaveGone.replace(/'/g, "&#x27;")), gone.includes(`/@${HANDLE}/manage?token=${token}`)], [true, true]);
  is("an unknown membership: one h1, Your membership", headings(await html({ token, sub: "sub_NotThisOne001" })), [m.yourMembership]);

  part("A membership that can be canceled: unchanged");
  ending = false;
  const open = await html({ token, sub });
  is("one h1, the leave heading", headings(open), [m.leaveHeadPlain]);
  is("the way out kept", open.includes("data-leave-cancel"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
