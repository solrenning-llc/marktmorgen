/**
 * R31, finding 4 (synthetic only): a list download (GET /api/store/leads,
 * lib/free.ts listAsCsv) and the buyers audience (GET /api/store/audience,
 * lib/ad-audience.ts) read the whole list, up to MAX_LEADS contacts on every
 * plan, and send a file sized by it. They used to take only one of the
 * ESSENTIAL_PER_DAY requests, priced as one request of 40 commands and
 * 200,000 bytes (tests/plan-cost-registry.ts, line "studio"), so a list of
 * 3,000 contacts already read 5.5 times what that line prices.
 *
 * Now each download counts the list exactly first (one HLEN, read in its
 * exact shape, CX-123 rule 24) and takes from the store's studio figure the
 * units its reads and its file cost (lib/list-download.ts, the unit of a
 * whole store export: lib/store-export.ts), before anything of the list is
 * read. A count that does not read, or a figure without the units, refuses
 * before the list is read and takes nothing.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { CONTACT_READ_BYTES, importContactRows, leadsKey } from "@/lib/contacts";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allowanceUsed, forceAllowance } from "@/lib/store-allowance";
import { NON_PAYING_ALLOWANCES, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import * as closingRules from "@/lib/plan-closing-rules";
import { personKey } from "@/lib/person-key";
import { writeFields } from "@/lib/crm";
import { MAX_CONTACT_NAME, MAX_CONTACT_TAGS, MAX_TAG_LENGTH } from "@/lib/contact-rules";
import { MAX_CRM_FIELDS, MAX_FIELD_VALUE } from "@/lib/crm-rules";
import { DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { MAX_STORE_BYTES } from "@/lib/store";
import { GET as leadsGet } from "@/app/api/store/leads/route";
import { GET as audienceGet } from "@/app/api/store/audience/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import * as registry from "./plan-cost-registry";
import { ORIGIN_PER_BYTE, UNIT_COST, closureCost, request } from "./plan-cost-registry";
import { MAX_LEADS } from "@/lib/contact-rules";
import { LIST_CONTACTS_PER_COMMAND, listDownloadHeld, listDownloadUnits, listPageMost } from "@/lib/list-download";

const N = 3_000;

type Store = NonNullable<Awaited<ReturnType<typeof storeForEmail>>>;
type Route = (request: NextRequest) => Promise<Response>;

async function storeWith(owner: string, handle: string, contacts: number, ended = false): Promise<{ store: Store; session: string }> {
  await claimHandle(owner, handle, "R31 List", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const rows = Array.from({ length: contacts }, (_, i) => ({ email: `person${i}@example.com`, name: `Person Number ${i}`, tags: ["webinar", "spring"], consent: "agreed" as const }));
  for (let i = 0; i < rows.length; i += 500) await importContactRows(store.listId!, rows.slice(i, i + 500), store);
  // A plan that ended: the store keeps its list, and the studio figure of a store whose plan has ended.
  if (ended) await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: false });
  return { store: (await storeForEmail(owner))!, session: await openSession(owner) };
}

/**
 * A list of `contacts` people none of whom agreed to emails, each record at every cap a contact has (its name, its
 * labels, MAX_TITLES products asked for), with the store's MAX_CRM_FIELDS fields each holding a value at its cap:
 * what the agreed-only file and the buyers audience read for every person they leave out.
 */
async function storeAtCaps(owner: string, handle: string, contacts: number): Promise<{ store: Store; session: string }> {
  const { store, session } = await storeWith(owner, handle, 0);
  const fields = Array.from({ length: MAX_CRM_FIELDS }, (_, i) => ({ id: `fld${String(i).padStart(3, "0")}`, name: `Field ${i}`, type: "text" as const, options: [] }));
  await writeFields(store.statsId!, fields);
  const now = new Date().toISOString();
  const record = (i: number) =>
    JSON.stringify({
      agreed: false, agreedAt: "", firstAt: now, lastAt: now,
      titles: Array.from({ length: 20 }, (_, k) => `${k}`.padEnd(120, "t")),
      ids: Array.from({ length: 20 }, (_, k) => `prod${i}x${k}`.padEnd(24, "i")),
      source: "buyer", unsub: false, unsubAt: "", t: "a".repeat(40),
      name: "N".repeat(MAX_CONTACT_NAME), tags: Array.from({ length: MAX_CONTACT_TAGS }, (_, k) => `${k}`.padEnd(MAX_TAG_LENGTH, "g")), importedAt: now,
    });
  for (let i = 0; i < contacts; i += 500) {
    const page = Array.from({ length: Math.min(500, contacts - i) }, (_, k) => i + k);
    await redis.pipeline([["HSET", leadsKey(store.listId!), ...page.flatMap((n) => [`capped${n}@example.com`, record(n)])]]);
    await redis.pipeline(fields.map((f) => ["HSET", `nl:crm:v:${store.statsId}:${f.id}`, ...page.flatMap((n) => [personKey(store.statsId!, `capped${n}@example.com`), "v".repeat(MAX_FIELD_VALUE)])]));
  }
  return { store, session };
}

/** One download, with what it read from the database (commands, bytes, whether the list was walked) and what it sent. */
async function download(route: Route, path: string, store: Store, session: string, alter?: (command: (string | number)[]) => unknown) {
  let commands = 0;
  let bytes = 0;
  let walked = false;
  const pipeline = redis.pipeline;
  redis.pipeline = async (list) => {
    const replies = await pipeline(list);
    commands += list.length;
    bytes += JSON.stringify(replies).length;
    if (list.some((c) => c[0] === "HSCAN" && c[1] === leadsKey(store.listId!))) walked = true;
    return alter ? replies.map((reply, i) => (alter(list[i]) === undefined ? reply : alter(list[i]))) : replies;
  };
  const before = await allowanceUsed(store, "studio");
  try {
    const response = await route(new NextRequest(`https://marktmorgen.com${path}`, { headers: { host: "marktmorgen.com", "x-nimbus-store": store.sid, cookie: `${SESSION_COOKIE}=${session}` } }));
    const text = await response.text();
    const body = new TextEncoder().encode(text).length;
    redis.pipeline = pipeline;
    const taken = (await allowanceUsed(store, "studio")) - before;
    return { status: response.status, commands, bytes, sent: body, walked, taken, text };
  } finally {
    redis.pipeline = pipeline;
  }
}

/** What a download that read `bytes` in `commands` and sent `sent` costs at the most, by the registry's own prices. */
const costOf = (commands: number, bytes: number, sent: number) => request("heavy", commands, bytes) + sent * ORIGIN_PER_BYTE;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  for (const [name, route, path, handle] of [
    ["list download", leadsGet, "/api/store/leads", "rthirtyonelist"],
    ["buyers audience", audienceGet, "/api/store/audience", "rthirtyoneaudience"],
  ] as const) {
    redis.clear();
    const { store, session } = await storeWith(`r31-${name.replace(" ", "-")}@example.com`, handle, N);
    part(`A ${name} of ${N.toLocaleString("en-US")} contacts`);
    const got = await download(route, path, store, session);
    console.log(`status ${got.status}; commands ${got.commands}; bytes read ${got.bytes}; bytes sent ${got.sent}; studio units taken ${got.taken}`);
    is("(setup) it answered with the file", got.status, 200);
    is("the studio units it takes pay for what it read and sent", got.taken * UNIT_COST.studio >= costOf(got.commands, got.bytes, got.sent), true);

    part(`A ${name} whose count of the list comes back in a shape Redis does not give`);
    const odd = await download(route, path, store, session, (c) => (c[0] === "HLEN" && c[1] === leadsKey(store.listId!) ? "3000" : undefined));
    is("refused, not answered with a file", odd.status >= 500, true);
    is("the list is never walked", odd.walked, false);
    is("nothing taken from the studio figure", odd.taken, 0);

    part(`A ${name} when the studio figure has no room left for it`);
    await forceAllowance(store, "studio", STORE_ALLOWANCES.creator.studio);
    const spent = await download(route, path, store, session);
    is("refused as too many", spent.status, 429);
    is("the list is never walked", spent.walked, false);
    is("nothing more taken", spent.taken, 0);
  }

  part("The units pay for whatever a download sends and moves, read from the database or sent to the browser, by the registry's prices");
  // Measured, not estimated (second cost review of #3354): the units of `commands` commands and `bytes` bytes, every
  // byte priced as read (DB_BYTE) and, apart, as sent (ORIGIN_PER_BYTE), at a heavy request's shape.
  for (const commands of [0, 1, LIST_CONTACTS_PER_COMMAND, 16, 17, 2_330]) {
    for (const bytes of [0, 1, 1_000_000, 1_000_001, 37_000_000, 600_000_000]) {
      const units = listDownloadUnits(commands, bytes);
      const read = request("heavy", commands, bytes);
      const sent = request("heavy", commands, 0) + bytes * ORIGIN_PER_BYTE;
      is(`${commands} commands, ${bytes.toLocaleString("en-US")} bytes: ${units} units pay for them read or sent`, units * UNIT_COST.studio >= Math.max(read, sent), true);
    }
  }
  for (const contacts of [0, 1, N, MAX_LEADS]) {
    const first = listDownloadUnits(1, listPageMost(contacts) + 100);
    console.log(`${contacts} contacts: held first ${listDownloadHeld(contacts)}; the first page at its most ${first}; a page at its most ${listPageMost(contacts).toLocaleString("en-US")} bytes`);
    is(`${contacts} contacts: what is held first covers the first page of the walk at the most it can answer with`, listDownloadHeld(contacts) >= first, true);
    is(`${contacts} contacts: a page is held at the whole list as counted, never at COUNT alone`, listPageMost(contacts) >= contacts * CONTACT_READ_BYTES, true);
  }

  part("A list download when the studio figure has some room left, but less than the download needs");
  {
    redis.clear();
    const { store, session } = await storeWith("r31-words@example.com", "rthirtyonewords", N);
    const needs = listDownloadHeld(N);
    await forceAllowance(store, "studio", STORE_ALLOWANCES.creator.studio - 5);
    const short = await download(leadsGet, "/api/store/leads", store, session);
    const words = short.text;
    console.log(`needs ${needs}; answered: ${words}`);
    is("refused as too many", short.status, 429);
    is("the list is never walked", short.walked, false);
    is("it says how many the download needs and how many are left, never that the figure is used", [words.includes(`needs ${needs} of your studio requests`), words.includes("only 5 are left"), /are used/.test(words)], [true, true, false]);
  }

  part("A list download whose take from the studio figure comes back in a shape Redis does not give");
  {
    redis.clear();
    const { store, session } = await storeWith("r31-unknown@example.com", "rthirtyoneunknown", N);
    const odd = await download(leadsGet, "/api/store/leads", store, session, (c) => (c[0] === "INCRBY" && String(c[1]).startsWith("nl:allow:studio:") ? "9" : undefined));
    is("refused as a count that could not be read (503), not as too many (429)", odd.status, 503);
    is("the list is never walked", odd.walked, false);
  }

  part("The people a file leaves out are read all the same: the agreed-only file and the buyers audience pay for them");
  {
    redis.clear();
    const capped = await storeAtCaps("r31-capped@example.com", "rthirtyonecapped", N);
    for (const [name, route, path] of [
      ["agreed-only file", leadsGet, "/api/store/leads?who=agreed"],
      ["buyers audience", audienceGet, "/api/store/audience"],
      // And everyone in the file, each with every field's value at its cap read for them (second cost review of #3354).
      ["whole file", leadsGet, "/api/store/leads"],
    ] as const) {
      const got = await download(route, path, capped.store, capped.session);
      console.log(`${name}: status ${got.status}; commands ${got.commands}; bytes read ${got.bytes} (${Math.round(got.bytes / N)} a person); bytes sent ${got.sent}; units ${got.taken} ($${(got.taken * UNIT_COST.studio).toFixed(6)}) for $${costOf(got.commands, got.bytes, got.sent).toFixed(6)}`);
      is(`${name}: (setup) answered with its file (of nobody, but for the whole file)`, [got.status, got.walked, name === "whole file" ? got.text.includes(`capped${N - 1}@example.com`) && got.text.includes("v".repeat(MAX_FIELD_VALUE)) : got.sent < 1_000], [200, true, true]);
      is(`${name}: the studio units it takes pay for every person it read, sent or not`, got.taken * UNIT_COST.studio >= costOf(got.commands, got.bytes, got.sent), true);
    }
  }

  part("A store whose plan has ended downloads its list, however large, from an allowance of its own");
  {
    const endedLists = (closingRules as Record<string, unknown>).ENDED_LIST_DOWNLOADS;
    is("a store whose plan has ended has its own list downloads (ENDED_LIST_DOWNLOADS, at least one)", typeof endedLists === "number" && endedLists >= 1, true);
    const allowed = typeof endedLists === "number" && endedLists >= 1 ? endedLists : 1;
    redis.clear();
    const { store, session } = await storeWith("r31-ended@example.com", "rthirtyoneended", N, true);
    // Counted as a list of 50,000: what a store that had a larger plan may still hold.
    const large = (c: (string | number)[]) => (c[0] === "HLEN" && c[1] === leadsKey(store.listId!) ? 50_000 : undefined);
    is("(setup) its studio figure is the ended store's, smaller than such a list needs", NON_PAYING_ALLOWANCES.ended.studio < listDownloadHeld(50_000), true);
    const routes = [[leadsGet, "/api/store/leads"], [audienceGet, "/api/store/audience"], [leadsGet, "/api/store/leads?who=agreed"]] as const;
    for (let i = 0; i < allowed; i += 1) {
      const [route, path] = routes[i % routes.length];
      const got = await download(route, path, store, session, large);
      is(`download ${i + 1} of ${allowed} (${path}): answered with the file`, got.status, 200);
      is(`download ${i + 1} of ${allowed}: nothing taken from the ended store's studio figure`, got.taken, 0);
    }
    const past = await download(leadsGet, "/api/store/leads", store, session, large);
    const words = past.status === 200 ? "(a file)" : past.text;
    console.log(`past the allowance: ${past.status}: ${words}`);
    is("past its allowance: refused, the list never walked", [past.status, past.walked], [429, false]);
    is("and it says so: downloaded since the plan ended, never that requests are used", [/since your plan ended/.test(words), /are used/.test(words)], [true, false]);

    redis.clear();
    const other = await storeWith("r31-ended-odd@example.com", "rthirtyoneendedodd", N, true);
    const odd = await download(leadsGet, "/api/store/leads", other.store, other.session, (c) => (c[0] === "INCR" && String(c[1]).includes(":list-ended:") ? "1" : undefined));
    is("its own count read in a shape Redis does not give: refused as unknown (503), the list never walked", [odd.status, odd.walked], [503, false]);
  }

  part("Those downloads are priced with the store's closing, as its whole exports are (tests/plan-cost-registry.ts, closure)");
  {
    const endedLists = (closingRules as Record<string, unknown>).ENDED_LIST_DOWNLOADS;
    const listCost = (registry as Record<string, unknown>).endedListDownloadCost;
    for (const tier of ["creator", "pro", "scale"] as const) {
      const closure = closureCost(tier) as ReturnType<typeof closureCost> & { lists?: number };
      const priced = typeof listCost === "function" && typeof endedLists === "number" ? endedLists * (listCost as (bytes: number) => number)(DATA_ROOM_BYTES[tier] + MAX_STORE_BYTES) : NaN;
      is(`${tier}: the closing carries ENDED_LIST_DOWNLOADS list downloads, each at the largest list its room can hold`, [typeof closure.lists === "number" && closure.lists > 0, closure.lists === priced, closure.total >= closure.deletes + closure.follows + closure.exports + closure.prepare + (closure.lists ?? NaN)], [true, true, true]);
    }
  }

  part("A list download reads the fields' values of the people on the list only, and pays for every byte it reads (second cost review of #3354)");
  {
    redis.clear();
    // No contact on the list, and the store's MAX_CRM_FIELDS fields each holding a value at its cap for 6,000 people
    // who are not on it: values outlive a contact's removal, so these are bounded only by the store's data room.
    const { store, session } = await storeWith("r31-values@example.com", "rthirtyonevalues", 0);
    const fields = Array.from({ length: MAX_CRM_FIELDS }, (_, i) => ({ id: `val${String(i).padStart(3, "0")}`, name: `Value ${i}`, type: "text" as const, options: [] }));
    await writeFields(store.statsId!, fields);
    for (let i = 0; i < 6_000; i += 500) {
      const page = Array.from({ length: 500 }, (_, k) => i + k);
      await redis.pipeline(fields.map((f) => ["HSET", `nl:crm:v:${store.statsId}:${f.id}`, ...page.flatMap((n) => [personKey(store.statsId!, `gone${n}@example.com`), "v".repeat(MAX_FIELD_VALUE)])]));
    }
    const got = await download(leadsGet, "/api/store/leads", store, session);
    console.log(`0 contacts, ${MAX_CRM_FIELDS} fields x 6,000 people off the list: status ${got.status}; commands ${got.commands}; bytes read ${got.bytes}; units ${got.taken} ($${(got.taken * UNIT_COST.studio).toFixed(6)}) for $${costOf(got.commands, got.bytes, got.sent).toFixed(6)}`);
    is("(setup) answered with the file", got.status, 200);
    is("the values of people who are not on the list are never read", got.bytes < 100_000, true);
    is("the studio units it takes pay for every byte it read and sent", got.taken * UNIT_COST.studio >= costOf(got.commands, got.bytes, got.sent), true);

    // Control: a person on the list still has their values in the file.
    await importContactRows(store.listId!, [{ email: "kept@example.com", name: "Kept Person", tags: [], consent: "agreed" as const }], store);
    await redis.pipeline([["HSET", `nl:crm:v:${store.statsId}:${fields[3].id}`, personKey(store.statsId!, "kept@example.com"), "kept-value-3"]]);
    const kept = await download(leadsGet, "/api/store/leads", store, session);
    is("control: a person on the list keeps their value in the file", [kept.status, kept.text.includes("kept@example.com"), kept.text.includes("kept-value-3")], [200, true, true]);

    // Rule 24: the values or the fields read in a shape Redis does not give are unknown, never a file with them left out.
    const oddValues = await download(leadsGet, "/api/store/leads", store, session, (c) => (String(c[1]).startsWith(`nl:crm:v:${store.statsId}:`) ? "odd" : undefined));
    is("the fields' values read in an odd shape: refused, never a file with the values left empty", [oddValues.status, oddValues.text.includes("kept@example.com")], [502, false]);
    const oddFields = await download(leadsGet, "/api/store/leads", store, session, (c) => (c[0] === "GET" && c[1] === `nl:crm:fields:${store.statsId}` ? 42 : undefined));
    is("the fields read in an odd shape: refused, never a file without their columns", [oddFields.status, oddFields.text.includes("kept@example.com")], [502, false]);
  }

  part("A download never takes past the studio figure: each read is held before it is made (second cost review of #3354)");
  for (const [name, route, path, handle] of [
    ["agreed-only file", leadsGet, "/api/store/leads?who=agreed", "rthirtyoneexacta"],
    ["buyers audience", audienceGet, "/api/store/audience", "rthirtyoneexactb"],
    ["whole file", leadsGet, "/api/store/leads", "rthirtyoneexactc"],
  ] as const) {
    redis.clear();
    // A list at every cap, with exactly what is held first left in the studio figure.
    const capped = await storeAtCaps(`${handle}@example.com`, handle, N);
    const limit = STORE_ALLOWANCES.creator.studio;
    await forceAllowance(capped.store, "studio", limit - listDownloadHeld(N));
    const got = await download(route, path, capped.store, capped.session);
    const after = await allowanceUsed(capped.store, "studio");
    console.log(`${name}, ${listDownloadHeld(N)} left: status ${got.status}; bytes read ${got.bytes}; taken ${got.taken}; used ${after} of ${limit}; ${got.status === 200 ? "(a file)" : got.text}`);
    is(`${name}: never past the studio figure`, after <= limit, true);
    is(
      `${name}: a file only when its units pay for every byte read and sent; otherwise refused as too many, saying what is left, with nothing of the list sent`,
      got.status === 200 ? got.taken * UNIT_COST.studio >= costOf(got.commands, got.bytes, got.sent) : [got.status, /left/.test(got.text), got.text.includes("@example.com")].join(),
      got.status === 200 ? true : "429,true,false",
    );
  }

  part("Control: an empty list still downloads, for a few units");
  redis.clear();
  const empty = await storeWith("r31-empty@example.com", "rthirtyoneempty", 0);
  const nothing = await download(leadsGet, "/api/store/leads", empty.store, empty.session);
  is("answered with the file", nothing.status, 200);
  is("three units of the studio figure at the most: the request, its one command and its few bytes", nothing.taken >= 1 && nothing.taken <= 3, true);
  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
