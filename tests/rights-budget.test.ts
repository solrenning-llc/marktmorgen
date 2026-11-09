/**
 * A person's own request to have their data deleted (or copied) has its own
 * budget, never the store's studio figure (owner's decision 9, 9 November
 * 2026: "Cópia e apagamento a pedido da pessoa: orçamento próprio aprovado,
 * pago pelo plano nas lojas pagantes e pela empresa no resto. É dever legal.").
 *
 *   (1) A paying store whose studio figure is used up still deletes the
 *       person, through the emailed link and from the studio, and the studio
 *       figure is not touched by it: the plan's rights budget pays.
 *   (2) A store with no plan, whose free places are all taken this month,
 *       still deletes the person, and it is the company's cost: counted in the
 *       company's rights budget, never in a store figure.
 *   (3) When the month's rights budget is used up, nothing is refused: the
 *       deletion is scheduled and the person is told the truth, the date by
 *       which it is done by itself (one month after asking, GDPR art. 12(3),
 *       the time app/privacy/page.tsx promises), with nothing to press again.
 *       Unknown is never "done".
 *   (4) The plan's part is a line of tests/plan-cost-registry.ts, with a cap
 *       per store a month; the company's part a fixed, registered cap.
 */
import { createHash } from "node:crypto";
import { isValidElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import DeletePage from "@/app/privacy/delete/page";
import { POST } from "@/app/api/privacy/erase/route";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceWindow, calendarWindow } from "@/lib/allowance-window";
import { erasePerson } from "@/lib/person-erasure";
import { RIGHTS_PERSON_REQUESTS, RIGHTS_PLAN_UNITS } from "@/lib/rights-budget-rules";
import { COST_LINES } from "./plan-cost-registry";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

const month = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
const linkKey = (token: string) => `nl:erase:link:${createHash("sha256").update(`nimbus-erase-link:${token}`).digest("hex").slice(0, 40)}`;
const SPENT = "999999999";

/** One month after `at`, as GDPR art. 12(3) counts it: the same day of the next month, or its last day when it has none. */
function oneMonthAfter(at: number): Date {
  const d = new Date(at);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(d.getUTCDate(), last)));
}
const longDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

async function storeFor(handle: string, paid: boolean): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  if (paid) await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

/** The store's studio figure as counted now: every nl:allow:studio key of its window. */
function studioCount(store: Store): number {
  const window = allowanceWindow(store, Date.now());
  const keys = redis.keys().filter((k) => k.startsWith("nl:allow:studio:") && window && k.endsWith(`:${window.id}`));
  return keys.reduce((sum, k) => sum + Number(redis.run(["GET", k]) ?? 0), 0);
}

const contactOf = (store: Store, email: string) => redis.run(["HEXISTS", leadsKey(store.listId!), email]) === 1;

type Seen = { text: string; hrefs: string[]; regions: { role: string; text: string }[]; confirms: number };
function walk(node: ReactNode, out: Seen = { text: "", hrefs: [], regions: [], confirms: 0 }): Seen {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.text += String(node);
    return out;
  }
  if (!isValidElement<{ children?: ReactNode; href?: string; role?: string; name?: string; value?: string }>(node)) return out;
  if (typeof node.props.href === "string") out.hrefs.push(node.props.href);
  if (node.type === "input" && node.props.name === "action" && node.props.value === "confirm") out.confirms += 1;
  if (typeof node.props.role === "string") {
    const inner = walk(node.props.children);
    out.regions.push({ role: node.props.role, text: inner.text }, ...inner.regions);
    out.text += inner.text;
    out.hrefs.push(...inner.hrefs);
    out.confirms += inner.confirms;
    return out;
  }
  walk(node.props.children, out);
  return out;
}

/** Presses the button on a live link, as the person would, and opens the page the answer goes to. */
async function press(store: Store, email: string, token: string): Promise<{ status: string; page: Seen; kept: boolean }> {
  redis.run(["SET", linkKey(token), JSON.stringify({ e: email, s: [store.sid] }), "EX", 3600]);
  const response = await POST(
    new NextRequest("https://marktmorgen.com/api/privacy/erase", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://marktmorgen.com", host: "marktmorgen.com" },
      body: new URLSearchParams({ action: "confirm", token }),
    }),
  );
  const query = Object.fromEntries(new URL(response.headers.get("location")!).searchParams);
  return { status: query.status ?? "", page: walk(await DeletePage({ searchParams: Promise.resolve(query) })), kept: redis.run(["GET", linkKey(token)]) !== null };
}

async function main(): Promise<void> {
  redis.clear();
  const keyBefore = process.env.NIMBUS_DATA_KEY;
  process.env.NIMBUS_DATA_KEY = "synthetic-rights-budget-key-32-characters";
  try {
    part("(1) A paying store whose studio figure is used up still deletes the person, and the studio is not touched");
    const paid = await storeFor("rightspaid", true);
    is("the store's studio figure is taken whole first", (await takeAllowance(paid, "studio", allowanceFor(paid, "studio"))).ok, true);
    const before = studioCount(paid);
    const alice = "alice@example.com";
    await upsertContact(paid.listId!, alice, { agreed: true, explicit: true, source: "free" }, ROOM);
    const own = await press(paid, alice, "a".repeat(64));
    is("the person's own deletion is done", own.status, "done");
    is("the link is used up", own.kept, false);
    is("the page says it was deleted", /You were deleted from 1 store\b/.test(own.page.text), true);
    is("the contact is gone", contactOf(paid, alice), false);
    is("the studio figure did not move", studioCount(paid), before);
    const planCounter = `nl:rights:s:${paid.sid}:${month()}`;
    is("the plan's rights budget paid for it", Number(redis.run(["GET", planCounter]) ?? 0) > 0, true);
    const bob = "bob@example.com";
    await upsertContact(paid.listId!, bob, { agreed: true, explicit: true, source: "free" }, ROOM);
    const team = await erasePerson(paid, bob, { kind: "team", who: paid.email, role: "owner" });
    is("from the studio, with the studio figure used up, the deletion is done too", team.ok, true);
    is("and the studio figure still did not move", studioCount(paid), before);

    part("(2) A store with no plan, its free places all taken: deleted, at the company's cost");
    const free = await storeFor("rightsfree", false);
    redis.run(["SET", `nl:free:n:${calendarWindow().id}`, "1000000"]);
    const carol = "carol@example.com";
    await upsertContact(free.listId!, carol, { agreed: true, explicit: true, source: "free" }, ROOM);
    const freeBefore = studioCount(free);
    const gone = await press(free, carol, "b".repeat(64));
    is("the person's own deletion is done", gone.status, "done");
    is("the page says it was deleted", /You were deleted from 1 store\b/.test(gone.page.text), true);
    is("the contact is gone", contactOf(free, carol), false);
    is("no store figure paid: the studio did not move", studioCount(free), freeBefore);
    is("no plan budget was used", redis.run(["GET", `nl:rights:s:${free.sid}:${month()}`]), null);
    is("the company's rights budget paid for it", Number(redis.run(["GET", `nl:rights:co:${month()}`]) ?? 0) > 0, true);
    is("within this store's share of it", Number(redis.run(["GET", `nl:rights:f:${free.sid}:${month()}`]) ?? 0) > 0, true);
    redis.run(["DEL", `nl:free:n:${calendarWindow().id}`]);

    part("(3) The month's rights budget used up: scheduled, never refused, and the date said is the true one");
    const full = await storeFor("rightsfull", true);
    redis.run(["SET", `nl:rights:s:${full.sid}:${month()}`, SPENT]);
    const dave = "dave@example.com";
    await upsertContact(full.listId!, dave, { agreed: true, explicit: true, source: "free" }, ROOM);
    const asked = Date.now();
    const by = longDate(oneMonthAfter(asked));
    const later = await press(full, dave, "c".repeat(64));
    is("the press is not left for pressing again: it is scheduled", later.status, "done");
    is("the link is no longer needed", later.kept, false);
    is("the page says it is scheduled", /scheduled/i.test(later.page.text), true);
    is(`the page gives the date it is done by (${by})`, later.page.text.includes(by), true);
    is("never told to press again", /Press the button again/i.test(later.page.text), false);
    is("never told it was deleted from that store now", /You were deleted from 1 store\b/.test(later.page.text), false);
    is("the contact is not yet deleted (unknown is never done)", contactOf(full, dave), true);
    const eve = "eve@example.com";
    await upsertContact(full.listId!, eve, { agreed: true, explicit: true, source: "free" }, ROOM);
    const studio = await erasePerson(full, eve, { kind: "team", who: full.email, role: "owner" });
    is("from the studio: scheduled, not refused", studio.ok ? "ok" : studio.reason, "scheduled");
    is("with the date it is done by", !studio.ok && "by" in studio ? longDate(new Date(studio.by as number)) : "", by);

    part("(5) One person draws a store's budget at most RIGHTS_PERSON_REQUESTS times a month; past that, theirs waits too");
    const often = await storeFor("rightsoften", true);
    const zed = "zed@example.com";
    const results: string[] = [];
    for (let i = 0; i <= RIGHTS_PERSON_REQUESTS; i++) {
      await upsertContact(often.listId!, zed, { agreed: true, explicit: true, source: "free" }, ROOM);
      const r = await erasePerson(often, zed, { kind: "person" });
      results.push(r.ok ? "done" : r.reason);
    }
    is(`done ${RIGHTS_PERSON_REQUESTS} times, then scheduled, never refused`, results, [...Array(RIGHTS_PERSON_REQUESTS).fill("done"), "scheduled"]);
    is("and what is scheduled is still kept from the store's emails at once (the fingerprint)", redis.keys().some((k) => k.startsWith("nl:erased:")), true);

    part("(6) A deletion larger than a paying store's whole month is never left waiting: the company pays, now");
    const big = await storeFor("rightsbig", true);
    const many = { ...big, tier: "creator" as const, catalog: { ...big.catalog, items: [...big.catalog.items, ...Array.from({ length: 400 }, (_, i) => ({ id: `fakeproduct${String(i).padStart(4, "0")}`, kind: 0, options: [] }))] } };
    const wide = "wide@example.com";
    await upsertContact(big.listId!, wide, { agreed: true, explicit: true, source: "free" }, ROOM);
    const coBefore = Number(redis.run(["GET", `nl:rights:co:${month()}`]) ?? 0);
    const now = await erasePerson(many, wide, { kind: "person" });
    is("done now, not scheduled", now.ok ? "done" : now.reason, "done");
    is("the contact is gone", contactOf(big, wide), false);
    is("the company's budget paid", Number(redis.run(["GET", `nl:rights:co:${month()}`]) ?? 0) > coBefore, true);
    is("nothing left counted in the plan's month past its cap", Number(redis.run(["GET", `nl:rights:s:${big.sid}:${month()}`]) ?? 0) <= RIGHTS_PLAN_UNITS.creator, true);

    part("(4) The plan's part has its line, the company's a registered cap");
    const line = COST_LINES.find((l) => l.id === "data-rights");
    is("tests/plan-cost-registry.ts has a data-rights line", Boolean(line), true);
    is("it costs something on every plan (never zero)", line ? (["creator", "pro", "scale"] as const).every((t) => line.monthlyUsd(t) > 0) : false, true);
    is("it names the rules that cap it", line ? line.sources.some((s) => s.file === "lib/rights-budget-rules.ts") : false, true);
    const company = (registry as Record<string, unknown>).RIGHTS_COMPANY_COST as { monthlyUsd?: unknown } | undefined;
    is("the company's part is a registered, finite monthly cap", typeof company?.monthlyUsd === "number" && Number.isFinite(company.monthlyUsd) && company.monthlyUsd > 0, true);
  } finally {
    if (keyBefore === undefined) delete process.env.NIMBUS_DATA_KEY;
    else process.env.NIMBUS_DATA_KEY = keyBefore;
  }
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
