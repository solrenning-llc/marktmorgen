/**
 * The numbers emails' stop link and the team's list follow the store, not its
 * address (siblings of finding 5 of Claude 5's handles audit, 9 November 2026).
 *
 * 1. The stop link at the foot of the weekly, monthly, busy-day, quiet-sales
 *    and alert emails was signed for the store's ADDRESS. Once a store let an
 *    address go and, after the 30-day quarantine, another store took it, the
 *    old store's link stopped (or started again) the new store's emails. A link
 *    is now signed for the store's id; a link signed for an address, from an
 *    email sent before, is honored only for a store known to have held that
 *    address before links stopped being signed that way, never for one that
 *    may have taken it after another store let it go.
 * 2. Who on the team gets the weekly email (nl:weekly:to:<address>) was lost
 *    when the store was renamed: the members stopped getting it. It is now kept
 *    by the store's id, marked set; a list written before is read under the
 *    current address only (as before), moved whole to the id before a rename,
 *    and one under an address used before is never read (after a rename on main
 *    the owner chose again, so it would bring back members taken out since) and
 *    is taken out before that address is let go, so no other store inherits it.
 *
 * Synthetic data only; no request leaves the process.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, renameHandle, setSubscription, storeForEmail, type Store } from "@/lib/store";
import * as report from "@/lib/stats-report";
import { BUSY_FLOOR, maybeBusyAlert, setWeeklyOff, weeklyMemberToken, weeklyOff, weeklyToken } from "@/lib/stats-report";
import { GET as weeklyPage, POST as weeklyRoute } from "@/app/api/store/weekly/route";
import { POST as releaseRoute } from "@/app/api/store/release/route";
import { POST as renameRoute } from "@/app/api/store/rename/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_weekly_link_by_sid_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;

/** Emails handed to the sender; nothing else may leave the process. */
const sent: { to: string; text: string }[] = [];
const elsewhere: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    sent.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to), text: String(body.text ?? "") });
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

/** Rewrites fields of a store's own record, as a store made earlier (or before ids) would have them. */
async function edit(owner: string, fields: Record<string, unknown>): Promise<Store> {
  const [, keys] = redis.run(["SCAN", "0", "MATCH", "nl:store:owner:*", "COUNT", "1000"]) as [string, string[]];
  for (const key of keys) {
    const raw = redis.run(["GET", key]);
    if (typeof raw !== "string") continue;
    const record = JSON.parse(raw) as Record<string, unknown>;
    if (record.email !== owner) continue;
    redis.run(["SET", key, JSON.stringify({ ...record, ...fields })]);
  }
  return fresh(owner);
}

/** The stop link at the foot of today's busy-day email of the store, as the creator received it. */
async function busyDayLink(store: Store): Promise<string> {
  redis.run(["DEL", `nl:busy:${new Date().toISOString().slice(0, 10)}:${store.handle}`]);
  const before = sent.length;
  await maybeBusyAlert(store, BUSY_FLOOR);
  const mail = sent.slice(before).find((m) => m.to === store.email);
  return mail?.text.match(/https:\/\/marktmorgen\.com\/api\/store\/weekly\?\S+/)?.[0] ?? "";
}

/** The link pressed: "Stop these emails" (off) or "Start it again" (on). */
async function press(link: string, what: "off" | "on" = "off"): Promise<{ status: number; page: string }> {
  if (!link) return { status: 0, page: "no link" };
  const response = await weeklyRoute(
    new NextRequest(link, { method: "POST", headers: { host: HOST, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ do: what }).toString() }),
  );
  return { status: response.status, page: await response.text() };
}

const addressLink = (handle: string) => `${ORIGIN}/api/store/weekly?h=${encodeURIComponent(handle)}&t=${encodeURIComponent(weeklyToken(handle))}`;
const addressMemberLink = (handle: string, email: string) =>
  `${ORIGIN}/api/store/weekly?h=${encodeURIComponent(handle)}&e=${encodeURIComponent(email)}&t=${encodeURIComponent(weeklyMemberToken(handle, email))}`;

/** A studio request of the signed-in owner, for their store. */
async function studio(owner: string, store: Store, path: string, body: Record<string, unknown>): Promise<NextRequest> {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  return new NextRequest(`${ORIGIN}${path}?store=${store.sid}`, {
    method: "POST",
    headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Lets an address of the store go, then lets the quarantine pass, so another store may take it. */
async function letGo(owner: string, store: Store, handle: string): Promise<number> {
  const response = await releaseRoute(await studio(owner, store, "/api/store/release", { handle }));
  redis.run(["DEL", `nl:store:handle:${handle}`]);
  return response.status;
}

/** Renames the store from the studio, as its owner does (app/api/store/rename/route.ts); the answer's status. */
async function rename(owner: string, store: Store, handle: string): Promise<number> {
  return (await renameRoute(await studio(owner, store, "/api/store/rename", { handle }))).status;
}

/** The team list, through whatever the module offers for a store (before the fix: the address only). */
const teamOf = async (store: Store): Promise<unknown> => (report.weeklyTeam as (s: unknown) => Promise<string[]>)(store).catch((error: Error) => `threw: ${error.message}`);
const setTeam = (store: Store, emails: string[]) => (report.setWeeklyTeam as (s: unknown, e: string[]) => Promise<void>)(store, emails);

async function main(): Promise<void> {
  part("The audit's proof: an old store's stop link never changes the emails of the store that took its address");
  {
    const owner = "dock@example.com";
    let dock = await paidStore(owner, "dock", "Dock Prints");
    const link = await busyDayLink(dock);
    is("the busy-day email carries a stop link", link !== "", true);
    // The address rides along only for the page to show; the token is signed for the id with it (rule 23: the red
    // version also required no address in the link).
    is("the link names the store by its id", new URL(link).searchParams.get("s"), dock.sid);
    is("the store is renamed", (await renameHandle(owner, "dock-two")).ok, true);
    dock = await fresh(owner);
    is("the old address is let go", await letGo(owner, dock, "dock"), 200);
    const next = await paidStore("next-dock@example.com", "dock", "Another Dock");
    let pressed = await press(link, "off");
    is("the old email's link still reaches its own store", pressed.status, 200);
    is("its own store is stopped", await weeklyOff(await fresh(owner)), true);
    is("the store now at the address is not stopped", await weeklyOff(next), false);
    await setWeeklyOff(next, true);
    pressed = await press(link, "on");
    is("'Start it again' from the old email: its own store again", await weeklyOff(await fresh(owner)), false);
    is("the store now at the address stays stopped (no email without its consent)", await weeklyOff(next), true);
    pressed = await press(addressLink("dock"), "on");
    is("a link signed for the address, from before: nothing is changed", [pressed.status, /Nothing was changed/.test(pressed.page)], [404, true]);
    is("and the store now at the address stays stopped", await weeklyOff(next), true);
    const shown = await weeklyPage(new NextRequest(link, { headers: { host: HOST } }));
    is("the link's page opens with its button, without a press", [shown.status, /Stop these emails/.test(await shown.text())], [200, true]);
  }

  part("A link signed for the address, sent before: honored for a store that held the address before");
  {
    const owner = "pier@example.com";
    await paidStore(owner, "pier", "Pier Goods");
    let pier = await edit(owner, { createdAt: "2026-10-01T12:00:00.000Z" });
    let pressed = await press(addressLink("pier"), "off");
    is("pressed: stopped", [pressed.status, await weeklyOff(pier)], [200, true]);
    pressed = await press(addressLink("pier"), "on");
    is("'Start it again': on again", [pressed.status, await weeklyOff(pier)], [200, false]);
    is("a store made today takes an address", (await paidStore("quay@example.com", "quay", "Quay")).handle, "quay");
    pressed = await press(addressLink("quay"), "off");
    is("a link signed for an address a store took after such links ended: nothing is changed", pressed.status, 404);
    is("and that store is not stopped", await weeklyOff(await fresh("quay@example.com")), false);
    is("the store is renamed today", (await renameHandle(owner, "pier-two")).ok, true);
    pier = await fresh(owner);
    pressed = await press(addressLink("pier-two"), "off");
    is("a link signed for the address it took today: nothing is changed (it never had one)", pressed.status, 404);
    const link = await busyDayLink(pier);
    pressed = await press(link, "off");
    is("the newer email's link stops it", [pressed.status, await weeklyOff(pier)], [200, true]);
  }

  part("A store without an id yet keeps its address links (it has no other)");
  {
    const owner = "cove@example.com";
    await paidStore(owner, "cove", "Cove");
    const cove = await edit(owner, { sid: "" });
    const link = await busyDayLink(cove);
    is("its email's link names its address", /[?&]h=cove(&|$)/.test(link), true);
    const pressed = await press(link, "off");
    is("pressed: stopped", [pressed.status, await weeklyOff(cove)], [200, true]);
  }

  part("Who on the team gets the weekly email: kept through a rename, never inherited by the next store at the address");
  {
    const owner = "reef@example.com";
    let reef = await paidStore(owner, "reef", "Reef Studio");
    // What the code before this change wrote: the list under the address.
    redis.run(["SADD", "nl:weekly:to:reef", "ana@example.com"]);
    is("read under its address", await teamOf(reef), ["ana@example.com"]);
    // Rule 23: renamed through the studio's route, which keeps the list by the store's id before the address
    // changes (the red version renamed with renameHandle and relied on reading every address the store still owns,
    // which brought back members the owner had taken out after a rename on main: the part below).
    is("the store is renamed", await rename(owner, reef, "reef-two"), 200);
    reef = await fresh(owner);
    is("renamed: the members still get it", await teamOf(reef), ["ana@example.com"]);
    is("renamed: nothing is left under the old address", redis.run(["EXISTS", "nl:weekly:to:reef"]), 0);
    is("the old address is let go", await letGo(owner, reef, "reef"), 200);
    reef = await fresh(owner);
    is("let go: the members still get it", await teamOf(reef), ["ana@example.com"]);
    is("let go: nothing is left under the address", redis.run(["EXISTS", "nl:weekly:to:reef"]), 0);
    const next = await paidStore("next-reef@example.com", "reef", "Another Reef");
    is("the store now at the address has nobody on its list", await teamOf(next), []);
    await setTeam(next, ["ana@example.com"]);
    const pressed = await press(addressMemberLink("reef", "ana@example.com"));
    is("a member's link signed for the address, from before: nothing is changed", pressed.status, 404);
    is("the store now at the address keeps its member", await teamOf(next), ["ana@example.com"]);
    is("the owner changes the list: kept by the store's id", (await setTeam(reef, ["ben@example.com"]).then(() => "ok", (e: Error) => e.message)), "ok");
    is("changed", await teamOf(reef), ["ben@example.com"]);
    // Rule 23: through the studio's route, as above (the red version: renameHandle).
    is("renamed again", await rename(owner, reef, "reef-three"), 200);
    reef = await fresh(owner);
    is("renamed again: still the same list", await teamOf(reef), ["ben@example.com"]);
    const memberLink = (report as Record<string, unknown>).weeklyMemberStopUrl as ((s: Store, e: string) => string) | undefined;
    const own = typeof memberLink === "function" ? memberLink(reef, "ben@example.com") : "";
    is("a member's own link names the store by its id", /[?&]s=[0-9a-f]{32}&/.test(own), true);
    const left = await press(own);
    is("the member's own link stops their copy after a rename", [left.status, await teamOf(reef)], [200, []]);
  }

  part("A list kept under an address before a rename on main never comes back after its members left (pre-review P2)");
  {
    const owner = "skiff@example.com";
    let skiff = await paidStore(owner, "skiff", "Skiff");
    // On main: the owner chose M and N, under the address of then.
    redis.run(["SADD", "nl:weekly:to:skiff", "m@example.com", "n@example.com"]);
    // On main: renamed (main read the list under the current address only, so the owner chose again: N only).
    is("renamed on main", (await renameHandle(owner, "skiff-two")).ok, true);
    redis.run(["SADD", "nl:weekly:to:skiff-two", "n@example.com"]);
    skiff = await fresh(owner);
    is("main's list: N only", await teamOf(skiff), ["n@example.com"]);
    // On main: N pressed "Stop my copy" in an email signed for skiff-two.
    redis.run(["SREM", "nl:weekly:to:skiff-two", "n@example.com"]);
    is("nobody gets the weekly copy (M taken out, N stopped)", await teamOf(skiff), []);
    is("renamed back to the address of then, from the studio", await rename(owner, skiff, "skiff"), 200);
    skiff = await fresh(owner);
    is("back at the address of then: still nobody", await teamOf(skiff), []);
    is("renamed once more, from the studio", await rename(owner, skiff, "skiff-three"), 200);
    skiff = await fresh(owner);
    is("the old address is let go", await letGo(owner, skiff, "skiff"), 200);
    skiff = await fresh(owner);
    is("let go: still nobody", await teamOf(skiff), []);
    is("let go: nothing is left under the address", redis.run(["EXISTS", "nl:weekly:to:skiff"]), 0);
  }

  part("A list left under an address by a store before: never read by the store that renames to it");
  {
    redis.run(["SADD", "nl:weekly:to:raft-two", "stray@example.com"]);
    const owner = "raft@example.com";
    let raft = await paidStore(owner, "raft", "Raft");
    is("renamed from the studio to that address", await rename(owner, raft, "raft-two"), 200);
    raft = await fresh(owner);
    is("nobody from the list left there", await teamOf(raft), []);
  }

  part("Keeping the list by the store's id before a rename: a refused write never loses it, and the address stays");
  {
    const owner = "keel@example.com";
    let keel = await paidStore(owner, "keel", "Keel");
    redis.run(["SADD", "nl:weekly:to:keel", "ana@example.com"]);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      // As Redis refuses a SADD past its memory while other writes still run: only the other commands of the batch are done.
      if (commands.some((c) => c[0] === "SADD" && /^nl:weekly:(team|to):/.test(String(c[1])))) {
        const others = commands.filter((c) => c[0] !== "SADD");
        if (others.length) await pipeline(others);
        throw new Error("Redis error: OOM command not allowed when used memory > 'maxmemory'");
      }
      return pipeline(commands);
    }) as typeof redis.pipeline;
    const status = await rename(owner, keel, "keel-two");
    redis.pipeline = pipeline;
    is("the rename is refused", status >= 500, true);
    keel = await fresh(owner);
    is("the store keeps its address", keel.handle, "keel");
    is("the members still get it", await teamOf(keel), ["ana@example.com"]);
    is("renamed once the write goes through", await rename(owner, keel, "keel-two"), 200);
    is("and the members still get it", await teamOf(await fresh(owner)), ["ana@example.com"]);
  }

  part("A rename from the studio stays inside a studio request's commands (tests/plan-cost-registry.ts, UNIT_COST.studio)");
  {
    const owner = "oar@example.com";
    const oar = await paidStore(owner, "oar", "Oar");
    redis.run(["SADD", "nl:weekly:to:oar", "ana@example.com"]);
    const pipeline = redis.pipeline.bind(redis);
    let count = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      count += commands.length;
      return pipeline(commands);
    }) as typeof redis.pipeline;
    const status = await rename(owner, oar, "oar-two");
    redis.pipeline = pipeline;
    is("renamed", status, 200);
    is(`at most twenty commands (${count})`, count <= 20, true);
  }

  part("Every numbers email builds its stop link the one way");
  {
    const files = ["app/api/cron/weekly/route.ts", "app/api/cron/monthly/route.ts", "lib/quiet-sales.ts", "lib/store-alerts.ts", "lib/stats-report.ts"];
    const byAddress = files.filter((file) => /api\/store\/weekly\?h=\$\{encodeURIComponent\(store\.handle\)\}/.test(readFileSync(join(process.cwd(), file), "utf8")));
    is("no file signs a stop link for the address itself", byAddress, []);
  }

  part("The pages never offer a stop by replying: nothing reads the replies (VR 2)");
  {
    const nowhere = await press(addressLink("gone-nowhere"), "off");
    is("an address that leads nowhere: nothing is changed", nowhere.status, 404);
    is("its page offers the newest email's link, not a reply", [/repl(y|ying)/i.test(nowhere.page), /newest/.test(nowhere.page)], [false, true]);
    const unknown = await weeklyPage(new NextRequest(`${ORIGIN}/api/store/weekly?h=x&t=nope`, { headers: { host: HOST } }));
    const text = await unknown.text();
    is("a link not recognized: its page offers the newest email's link, not a reply", [unknown.status, /repl(y|ying)/i.test(text), /newest/.test(text)], [400, false, true]);
    const route = readFileSync(join(process.cwd(), "app/api/store/weekly/route.ts"), "utf8");
    is("no text of the stop page promises a stop by replying", /by replying|replying to/i.test(route), false);
  }

  part("Nothing left the process but the emails");
  is("no other request", elsewhere, []);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
