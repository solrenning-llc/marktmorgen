/**
 * A creator's "stop" survives renaming the store (finding 5 of Claude 5's
 * handles audit, 9 November 2026).
 *
 * The numbers emails' stop (nl:weekly:off, lib/stats-report.ts) and the
 * "Where did you hear about us?" switch (nl:heard:off, lib/heard.ts) were kept
 * under the store's address. Renaming the store lost them: the weekly, busy-day
 * and quiet-sales emails came back without the creator asking, and buyers were
 * asked again. A stop is now kept by the store's own id, a stop written before
 * under an address the store still owns is still read, one under an address it
 * let go of is carried to the id before it goes and is never read for the
 * store that takes the address next.
 *
 * The proof of the audit is the first part: stop from the email, rename, and
 * the routine sends nothing. Synthetic data only; no request leaves the process.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, renameHandle, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { BUSY_FLOOR, maybeBusyAlert, weeklyOff, weeklyToken } from "@/lib/stats-report";
import { heardOff, recordHeard } from "@/lib/heard";
import { POST as weeklyRoute } from "@/app/api/store/weekly/route";
import { POST as releaseRoute } from "@/app/api/store/release/route";
import { POST as heardAskRoute } from "@/app/api/store/heard-ask/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_email_stop_by_sid_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;

/** Emails handed to the sender; nothing else may leave the process. */
const sent: { to: string; subject: string }[] = [];
const elsewhere: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string };
    sent.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to), subject: String(body.subject) });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  elsewhere.push(`${url.hostname}${url.pathname}`);
  return new Response(JSON.stringify({ error: "not in this test" }), { status: 400 });
}) as typeof fetch;

async function paidStore(owner: string, handle: string, name: string): Promise<Store> {
  await claimHandle(owner, handle, name, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/\W/g, "")}0001`, subscriptionId: `sub_${handle.replace(/\W/g, "")}0001`, active: true, period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

const fresh = async (owner: string) => (await storeForEmail(owner))!;

/** The stop link at the foot of a numbers email, for the address it was sent under. */
function stopLink(handle: string, what: "off" | "on"): NextRequest {
  const form = new URLSearchParams({ do: what });
  return new NextRequest(`${ORIGIN}/api/store/weekly?h=${encodeURIComponent(handle)}&t=${encodeURIComponent(weeklyToken(handle))}`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

/** A studio request of the signed-in owner, for their store. */
async function studio(owner: string, store: Store, path: string, body: Record<string, unknown>): Promise<NextRequest> {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  return new NextRequest(`${ORIGIN}${path}?store=${store.sid}`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The busy-day email, today: whether it went, and how many reached the owner. */
async function busy(store: Store): Promise<{ said: boolean; emails: number }> {
  await redis.pipeline([["DEL", `nl:busy:${new Date().toISOString().slice(0, 10)}:${store.handle}`]]);
  const before = sent.length;
  const said = await maybeBusyAlert(store, BUSY_FLOOR);
  return { said, emails: sent.slice(before).filter((m) => m.to === store.email).length };
}

async function main(): Promise<void> {
  part("Numbers emails: stopped from the email, then the store renamed (the audit's proof)");
  {
    const owner = "crumb@example.com";
    let store = await paidStore(owner, "crumb", "Crumb Bakery");
    is("before any stop, a busy day's email goes", await busy(store), { said: true, emails: 1 });
    is("the stop link is pressed", (await weeklyRoute(stopLink("crumb", "off"))).status, 200);
    is("stopped under its first address", await weeklyOff(store), true);
    is("the store is renamed", (await renameHandle(owner, "crumbs")).ok, true);
    store = await fresh(owner);
    is("renamed: still stopped", await weeklyOff(store), true);
    is("renamed: no busy-day email", await busy(store), { said: false, emails: 0 });
    is("renamed twice", (await renameHandle(owner, "crumb-two")).ok, true);
    store = await fresh(owner);
    is("renamed twice: still stopped", await weeklyOff(store), true);
    is("renamed twice: no busy-day email", await busy(store), { said: false, emails: 0 });
    is("'Start it again' from the old email", (await weeklyRoute(stopLink("crumb", "on"))).status, 200);
    is("started again: not stopped", await weeklyOff(store), false);
    is("started again: the busy-day email goes", await busy(store), { said: true, emails: 1 });
    is("stopped from a newer email", (await weeklyRoute(stopLink("crumb-two", "off"))).status, 200);
    is("renamed back to an address it owns", (await renameHandle(owner, "crumb")).ok, true);
    store = await fresh(owner);
    is("renamed back: still stopped", await weeklyOff(store), true);
    is("renamed back: no busy-day email", await busy(store), { said: false, emails: 0 });
  }

  part("A stop written before, under the address: read while the store owns it, carried before it is let go");
  {
    const owner = "loaf@example.com";
    let store = await paidStore(owner, "loaf", "Loaf House");
    await setStripeAccount(owner, "acct_1TestStopBySid01", true);
    // What the code before this change wrote: the address itself.
    await redis.pipeline([["SADD", "nl:weekly:off", "loaf"], ["SADD", "nl:heard:off", "loaf"]]);
    is("the store is renamed", (await renameHandle(owner, "loaf-two")).ok, true);
    store = await fresh(owner);
    is("renamed: the old stop is still read", await weeklyOff(store), true);
    is("renamed: no busy-day email", await busy(store), { said: false, emails: 0 });
    is("renamed: buyers are still not asked", await heardOff(store), true);
    const release = await releaseRoute(await studio(owner, store, "/api/store/release", { handle: "loaf" }));
    is("the old address is let go", release.status, 200);
    store = await fresh(owner);
    is("let go: the address is no longer the store's", store.previousHandles.includes("loaf") || store.handle === "loaf", false);
    is("let go: still stopped", await weeklyOff(store), true);
    is("let go: no busy-day email", await busy(store), { said: false, emails: 0 });
    is("let go: buyers are still not asked", await heardOff(store), true);
    is("let go: an answer is not counted", await recordHeard(store, "cs_test_StopBySid00000001", "friend"), "off");

    // Thirty days on, the address is free, and another creator takes it.
    await redis.pipeline([["DEL", "nl:store:handle:loaf"]]);
    const other = await paidStore("other-loaf@example.com", "loaf", "Another Loaf");
    is("the next store at the address is not stopped by the old store's stop", await weeklyOff(other), false);
    is("the next store at the address gets its busy-day email", await busy(other), { said: true, emails: 1 });
    is("the next store at the address asks its buyers", await heardOff(other), false);
  }

  part("'Where did you hear about us?' switched off in the studio, then the store renamed");
  {
    const owner = "bun@example.com";
    let store = await paidStore(owner, "bun", "Bun Corner");
    await setStripeAccount(owner, "acct_1TestStopBySid02", true);
    is("switched off in the studio", (await heardAskRoute(await studio(owner, store, "/api/store/heard-ask", { ask: false }))).status, 200);
    is("off under its first address", await heardOff(store), true);
    is("the store is renamed", (await renameHandle(owner, "bun-two")).ok, true);
    store = await fresh(owner);
    is("renamed: still off", await heardOff(store), true);
    is("renamed: an answer is not counted", await recordHeard(store, "cs_test_StopBySid00000002", "friend"), "off");
    is("switched on again", (await heardAskRoute(await studio(owner, store, "/api/store/heard-ask", { ask: true }))).status, 200);
    is("on again", await heardOff(store), false);
  }

  part("Nothing left the process but the emails");
  is("no other request", elsewhere, []);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
