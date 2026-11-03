/**
 * Saving a call's other lengths from the studio (637 [GL5], unit 3; added
 * 3 November 2026), called as the studio calls it, on the in-memory store
 * with Stripe mocked: the call's own length first at the product's price,
 * each other one longer at its own price, checked with the store's currency
 * and the rules (lib/call-lengths.ts, readCallLengths); never a list sent
 * from outside, never with a package or a team; the editor's summary says
 * each length.
 */
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { POST as saveCall } from "@/app/api/store/call/route";
import { POST as saveTeam } from "@/app/api/store/call-team/route";
import { CallEditor } from "@/components/call-editor";
import { addProduct, claimHandle, ensureStatsId, setCallPackage, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "lena@example.com";
const NY = "America/New_York";
const WEEK: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const call = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEK, noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1 };

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_call_lengths_editor";
  await claimHandle(OWNER, "lena", "Lena Coaching", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLena00001", true);
  await setSubscription(OWNER, { customerId: "cus_lena00001", subscriptionId: "sub_lena00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const store = (await storeForEmail(OWNER))!;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const post = async (route: typeof saveCall, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return (await response.json()) as { ok: boolean; error?: string; problem?: string; minutes?: number };
  };
  const kept = async () => (await readProduct((await storeForEmail(OWNER))!, id))?.call?.lengths;

  part("Saved from the studio");
  is("the call's own length first, at the product's price, then each other one at its own", [(await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }, { minutes: 90, price: "110.50" }] })).ok, await kept()], [true, [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 8000 }, { minutes: 90, cents: 11050 }]]);
  is("saved with none, the call has one length again", [(await post(saveCall, "call", { id, call, lengths: [] })).ok, await kept()], [true, undefined]);
  is("and saved without the field, too", [(await post(saveCall, "call", { id, call: { ...call } })).ok, await kept()], [true, undefined]);

  part("Refused, saying why");
  const refused = await Promise.all([
    post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "0" }] }),
    post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }, { minutes: 60, price: "90" }] }),
    post(saveCall, "call", { id, call: { ...call, minutes: 60 }, lengths: [{ minutes: 30, price: "20" }] }),
    post(saveCall, "call", { id, call: { ...call, weekly: [[], [[540, 600]], [], [], [], [], []] }, lengths: [{ minutes: 90, price: "110" }] }),
    post(saveCall, "call", { id, call: { ...call, seats: 3 }, lengths: [{ minutes: 60, price: "80" }] }),
    post(saveCall, "call", { id, call, lengths: [{ minutes: 45, price: "60" }, { minutes: 60, price: "80" }, { minutes: 90, price: "110" }] }),
  ]);
  is("no price, twice, shorter than the call's own, too long for the hours, a group, more than three in all", refused.map((r) => [r.ok, r.error, r.problem, r.minutes ?? null]), [[false, "lengths", "price", null], [false, "lengths", "twice", null], [false, "lengths", "shorter", null], [false, "lengths", "fits", 90], [false, "lengths", "kind", null], [false, "lengths", "too_many", null]]);
  is("a stored list sent from outside is never taken", (await post(saveCall, "call", { id, call: { ...call, lengths: [{ minutes: 30, cents: 4500 }, { minutes: 60, cents: 1 }] } })).error, "lengths");
  is("nothing was kept by any of them", await kept(), undefined);

  part("Never with a package or a team");
  await setCallPackage(OWNER, id, { sessions: 5, priceCents: 20000, days: 0 });
  is("a call sold in packages keeps one length", (await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }] })).problem, "package");
  await setCallPackage(OWNER, id, null);
  await post(saveCall, "call", { id, call, lengths: [{ minutes: 60, price: "80" }] });
  is("and a call with several lengths takes no package", await setCallPackage(OWNER, id, { sessions: 5, priceCents: 20000, days: 0 }), { ok: false, reason: "lengths" });
  is("nor a team", (await post(saveTeam as typeof saveCall, "call-team", { id, team: { hosts: [{ email: OWNER }], mode: "round" } })).error, "team_lengths");

  part("In the studio");
  const product = (await readProduct((await storeForEmail(OWNER))!, id))!;
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, createElement(CallEditor, { product, email: OWNER })));
  is("the summary says each length", html.includes("Paid call · 30, 60 minutes · America/New_York"), true);
  const changed = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, createElement(CallEditor, { product: { ...product, priceCents: 5000 }, email: OWNER })));
  is("a price changed since says only the first length is on sale, and how to offer the others", changed.includes("only the first length is on sale. Open the hours and save them again to offer the others."), true);
  const editor = readFileSync("components/call-editor.tsx", "utf8");
  is("other lengths are a named group, one person a time only, each price with its hint, each row removable by name", [editor.includes('<legend className="field-label">Other lengths (optional)</legend>'), editor.includes("{Number(draft.seats) === 1 ? ("), editor.includes("aria-describedby={`lengths-price-${id}`}"), editor.includes("{`Remove ${row.minutes} minutes`}")], [true, true, true, true]);
  is("the team and package editors say why", [readFileSync("components/team-event-editor.tsx", "utf8").includes("team_lengths:"), readFileSync("components/package-editor.tsx", "utf8").includes("lengths:")], [true, true]);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
