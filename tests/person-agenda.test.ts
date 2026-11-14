/**
 * 639 [GL7](6), unit 3: the tasks agenda on the studio's buyers page
 * (lib/person-agenda.ts, app/studio/people/page.tsx). Who a task is about is
 * found among the store's buyers by the key the task is kept under, never
 * stored or guessed; groups in the order to act on them, cut with the rest
 * counted; each row opening the person's page by that key.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type AgendaListRow, TasksAgendaList, agendaDay, agendaLinkWords, staleWords } from "@/components/tasks-agenda";
import { AGENDA_ROW_MARKUP_BYTES, AGENDA_SHOWN, AGENDA_UNITS, PERSON_KEY, agendaReadUnits, addressForPerson, addressesOf, agendaForDays, agendaGroups, daysAround } from "@/lib/person-agenda";
import { personKey } from "@/lib/person-key";
import { redisPipeline } from "@/lib/redis";
import { BUYER_LEDGER_UNITS, IMPORTED_BUYER_BYTES, LedgerNotCounted, buyerLedger, ledgerReadBytes, ledgerUnits } from "@/lib/segments";
import type { DueTask, PersonTask } from "@/lib/person-tasks";
import type { Store } from "@/lib/store";
import { agendaData, countLedger, countUnits } from "@/lib/person-agenda-read";
import { IncludedBytes } from "@/lib/sent-bytes";
import { countStudio } from "@/lib/studio-route";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

async function main() {
  const STATS = "s".repeat(16);
  const ann = personKey(STATS, "ann@example.com");
  const bob = personKey(STATS, "bob@example.com");
  const ghost = personKey(STATS, "ghost@example.com");
  const task = (n: number, over: Partial<PersonTask> = {}): PersonTask => ({ id: `task${String(n).padStart(6, "0")}`, text: `Task ${n}`, due: "", assignee: "", done: false, createdAt: n, doneAt: 0, ...over });
  const due = (person: string, n: number, over: Partial<PersonTask> = {}): DueTask => ({ person, task: task(n, over) });

  part("Who a task is about");
  const found = addressesOf(STATS, new Set([ann, ghost]), ["bob@example.com", "Ann@Example.com", "ann@example.com"]);
  is("found by the key the task is kept under, the first address that has it", [found.get(ann), found.size], ["Ann@Example.com", 1]);
  is("someone not among the buyers is not guessed", found.has(ghost), false);
  is("nobody wanted, nothing read", addressesOf(STATS, new Set(), ["ann@example.com"]).size, 0);
  is("a person's key is the 32 characters the tasks use", [PERSON_KEY.test(ann), PERSON_KEY.test("ann@example.com")], [true, false]);
  is("a page asked for by a bad key reads nothing", await addressForPerson({ statsId: STATS } as Store, "../ann"), null);

  part("The groups");
  const groups = agendaGroups({ overdue: [due(ann, 1, { due: "2026-11-01" })], today: [], upcoming: [due(bob, 2, { due: "2026-11-09" })], undated: [due(ghost, 3)] }, new Map([[ann, "ann@example.com"]]));
  is("in the order to act on them, an empty group left out", groups.map((group) => group.title), ["Past their date", "Coming up", "No date"]);
  is("each row with its address, or none when not found", groups.map((group) => group.rows[0].email), ["ann@example.com", null, null]);
  const many = agendaGroups({ overdue: [], today: Array.from({ length: AGENDA_SHOWN + 7 }, (_, i) => due(ann, i + 1, { due: "2026-11-03" })), upcoming: [], undated: [] }, new Map());
  is("a long group cut, the rest counted", [many[0].rows.length, many[0].more], [AGENDA_SHOWN, 7]);
  is("nothing open, no groups", agendaGroups({ overdue: [], today: [], upcoming: [], undated: [] }, new Map()).length, 0);

  part("The creator's own day, not the server's");
  // 01:30 UTC on 4 November: the server's day is the 4th, and in Fortaleza (UTC-3) it is 22:30 on the 3rd.
  is("the days the creator's may be: the one before, the server's and the one after", [daysAround("2026-11-04"), daysAround("2026-12-31"), daysAround("2026-03-01")], [
    ["2026-11-03", "2026-11-04", "2026-11-05"],
    ["2026-12-30", "2026-12-31", "2027-01-01"],
    ["2026-02-28", "2026-03-01", "2026-03-02"],
  ]);
  const entries = [due(ann, 1, { due: "2026-11-03" }), due(bob, 2, { due: "2026-11-04" }), due(ann, 3, { due: "2026-11-02" }), due(bob, 4, { done: true, due: "2026-11-01" })];
  const agenda = agendaForDays(entries, daysAround("2026-11-04"));
  const titles = (day: string) => Object.fromEntries(agenda.days[day].map((group) => [group.title, group.rows.map((place) => agenda.rows[place].task.text)]));
  is("on the 3rd in Fortaleza, the task due the 3rd is due today and the 4th's is to come", titles("2026-11-03"), { "Past their date": ["Task 3"], "Due today": ["Task 1"], "Coming up": ["Task 2"] });
  is("on the 4th in UTC, the 3rd's is past", titles("2026-11-04"), { "Past their date": ["Task 3", "Task 1"], "Due today": ["Task 2"] });
  is("each open task sent once, a done one never", agenda.rows.map((row) => row.task.text).sort(), ["Task 1", "Task 2", "Task 3"]);
  const rows: AgendaListRow[] = agenda.rows.map((row) => ({ ...row, email: row.person === ann ? "ann@example.com" : null, href: row.person === ann ? `/studio/people?who=${ann}` : "" }));
  const drawn = (serverDay: string) => renderToStaticMarkup(createElement(TasksAgendaList, { rows, days: agenda.days, serverDay, found: { partial: false } }));
  const fortaleza = drawn("2026-11-03");
  // One row's own markup, beside what the row says, fits AGENDA_ROW_MARKUP_BYTES, found or not (round 7, L2).
  const oneRow = (email: string | null) => {
    const row: AgendaListRow = { person: ann, task: { id: "abcdefghij", text: "Call", due: "2026-11-03", assignee: "sam@example.com", done: false, createdAt: 1, doneAt: 0 }, email, href: email ? `/studio/people?who=${ann}` : "" };
    const one = agendaForDays([{ person: ann, task: row.task }], ["2026-11-03"]);
    const html = renderToStaticMarkup(createElement(TasksAgendaList, { rows: [row], days: one.days, serverDay: "2026-11-03", found: { partial: false } }));
    const li = html.slice(html.indexOf("<li"), html.indexOf("</li>") + 5);
    return Buffer.byteLength(li) - [row.task.text, row.task.assignee, email ?? "", row.href].reduce((n, t) => n + Buffer.byteLength(t), 0);
  };
  is("one agenda row's own markup fits AGENDA_ROW_MARKUP_BYTES, with the person found and not", [oneRow("ann@example.com") <= AGENDA_ROW_MARKUP_BYTES, oneRow(null) <= AGENDA_ROW_MARKUP_BYTES, oneRow("ann@example.com") > 100], [true, true, true]);
  is("drawn for the 3rd: due today, not past", [fortaleza.includes("Due today (1)"), fortaleza.includes("Due Nov 3, 2026"), fortaleza.includes("Was due Nov 3, 2026")], [true, true, false]);
  is("and the 2nd's past, the 4th's to come", [fortaleza.includes("Was due Nov 2, 2026"), fortaleza.includes("Due Nov 4, 2026")], [true, true]);
  is("drawn for the 4th, the 3rd's is past", drawn("2026-11-04").includes("Was due Nov 3, 2026"), true);
  is("a row opens the person's page, or says they were not found", [fortaleza.includes(`href="/studio/people?who=${ann}"`), fortaleza.includes("About a person we could not find among your Stripe buyers.")], [true, true]);
  is("the link says where it goes, not only whose address it is, in words everyone sees (2.4.9)", fortaleza.includes(">Open the buyer page of ann@example.com</a>") && !fortaleza.includes("sr-only\">: open their page"), true);
  is("someone not found is pointed to the search by its name, never by where it is on the page (1.3.3)", [fortaleza.includes("search for their address under Find a buyer."), fortaleza.includes("above")], [true, false]);
  is("a reading cut short is said", renderToStaticMarkup(createElement(TasksAgendaList, { rows, days: agenda.days, serverDay: "2026-11-03", found: { partial: true } })).includes("buyers (the oldest buyers are not read). To open"), true);
  const list = readFileSync("components/tasks-agenda.tsx", "utf8");
  is("the browser's day takes over after the server's drawing", list.includes("const creatorDay = useCreatorDay(serverDay);") && list.includes("const { today, stale } = agendaDay(days, creatorDay, serverDay);"), true);

  part("A page left open, and its links (edge review)");
  is("a day the server made the groups for is drawn as it is", agendaDay(agenda.days, "2026-11-05", "2026-11-04"), { today: "2026-11-05", stale: false });
  is("two midnights later the groups are out of date, and it is said, never guessed; the latest day made is shown (round 3, L4)", [agendaDay(agenda.days, "2026-11-07", "2026-11-04"), agendaDay(agenda.days, "__proto__", "2026-11-04").stale], [{ today: "2026-11-05", stale: true }, true]);
  is("the creator is offered to read them again, never moved by the page on its own", list.includes("onClick={() => window.location.reload()}") && !list.includes("router.refresh()"), true);
  // Drawn for a day the groups were not made for, as a page left open two midnights later is.
  const late = drawn("2026-11-09");
  is("a status region is there before anything is said (round 2, B-M)", /^<div role="status"><\/div>/.test(fortaleza), true);
  is("then it says which day the groups show and that a new one started (round 2, B-L), never that this is the day the page was opened (round 3, L4)", late.includes('<div role="status" class="notice notice-info mt-4">Showing the tasks as of Nov 5, 2026. A new day has started since, so some may be past their date now.</div>') && !late.includes("opened"), true);
  is("with the button to read them again outside the region, tall enough to tap (btn-sm, 44 px)", /<\/div><button type="button" class="btn btn-secondary btn-sm mt-3">Reload the tasks<\/button>/.test(late) && !/role="status"[^>]*>[^<]*<button/.test(late), true);
  is("the person's day moves on at midnight on its own (components/person-tasks.tsx, watchDay)", readFileSync("components/person-tasks.tsx", "utf8").includes("useSyncExternalStore(watchBrowserDay,"), true);
  is("the sentence names the day, in words", staleWords("2026-11-04").startsWith("Showing the tasks as of Nov 4, 2026."), true);
  is("a link's own words say where it goes, not an address alone", [agendaLinkWords("ann@example.com"), fortaleza.includes(">Open the buyer page of ann@example.com</a>")], ["Open the buyer page of ann@example.com", true]);

  part("What the agenda costs, counted before it reads (round 3, M2)");
  // The reading of the buyers is counted before anything big is read: its one-hour copy by its size, Stripe and
  // the imported buyers by how many (round 4, H1).
  const shop = { statsId: "ledgerstats", currency: "usd", stripeAccountId: "acct_ledger" } as Store;
  const asked: number[] = [];
  const refusedCount = async (units: number) => { asked.push(units); return false; };
  const importedPipe = Array.from({ length: 5_000 }, (_, i) => ["HSET", "nl:imp:who:ledgerstats", `imported${i}@example.com`, "1"]);
  await redisPipeline(importedPipe);
  const notCounted = await buyerLedger(shop, refusedCount).then(() => "read", (error: unknown) => (error instanceof LedgerNotCounted ? "not counted" : String(error)));
  is("a reading from Stripe counts BUYER_LEDGER_UNITS and the imported buyers by how many, and reads nothing when not counted", [notCounted, asked], ["not counted", [BUYER_LEDGER_UNITS + ledgerUnits(5_000 * IMPORTED_BUYER_BYTES)]]);
  is("5,000 imported buyers are 4 studio requests more", ledgerUnits(5_000 * IMPORTED_BUYER_BYTES), 4);
  const bigCopy = JSON.stringify({ c: "usd", p: false, r: [["ann@example.com", 100, 1, "", 1], ...Array.from({ length: 9_000 }, (_, i) => [`b${i}@example.com`, 0, 0, "direct", 0])], t: Date.now(), v: 6 });
  await redisPipeline([["SET", "nl:stats:ledgerstats:ledger", bigCopy, "EX", 600]]);
  asked.length = 0;
  const copyRefused = await buyerLedger(shop, refusedCount).then(() => "read", (error: unknown) => (error instanceof LedgerNotCounted ? "not counted" : String(error)));
  is("the one-hour copy is counted by its size before it is read", [copyRefused, asked], ["not counted", [ledgerUnits(bigCopy.length)]]);
  const kept = await buyerLedger(shop, async (units) => { asked.push(units); return true; });
  is("and read once counted", [kept.buyers.has("ann@example.com"), asked], [true, [ledgerUnits(bigCopy.length), ledgerUnits(bigCopy.length)]]);
  const buyersPage = readFileSync("app/studio/people/page.tsx", "utf8");
  is("the buyers page reads its agenda through agendaData, and says the allowance's own sentence when it is spent (round 4, L1)", buyersPage.includes("const data = await agendaData(store, today, included);") && buyersPage.includes('data.state === "refused" && data.message ? data.message') && buyersPage.includes("lookupLedger.said.message ||") && buyersPage.includes("data.ledgerMessage ?"), true);

  part("The agenda counted before it reads, on a real store (round 4, M4 and L5)");
  redis.clear();
  const owner = "agenda-owner@example.com";
  await claimHandle(owner, "agendashop", "Agenda Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_ag", subscriptionId: "sub_ag", active: true, tier: "creator", period: paidPeriod() });
  const realStore = (await storeForEmail(owner))!;
  const watch: string[][] = [];
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) watch.push(c.map(String));
    return pipe(commands);
  }) as typeof redis.pipeline;
  const studioCount = () => { const k = redis.keys().find((key) => key.startsWith("nl:allow:studio:")); return k; };
  const empty = await agendaData(realStore, "2026-11-04");
  is("with no task kept, nothing more is read and no studio request is counted (L5)", [empty.state, studioCount(), watch.some((c) => c[0] === "HGETALL")], ["empty", undefined, false]);
  // Three people with tasks: at the most a person's tasks weigh, more than the page's own request moves.
  for (const who of ["ann", "ben", "cy"]) await redisPipeline([["HSET", `nl:crm:tasks:${realStore.statsId}`, personKey(realStore.statsId!, `${who}@example.com`), JSON.stringify([{ id: "abcdefghij", text: `Call ${who}`, due: "", assignee: "", done: false, createdAt: 1, doneAt: 0 }])]]);
  await countStudio(realStore, null, 1);
  await redisPipeline([["SET", studioCount()!, String(allowanceFor(realStore, "studio"))]]);
  watch.length = 0;
  const spent = await agendaData(realStore, "2026-11-04");
  is("with fewer studio requests left than it needs, the agenda is refused, saying so, and reads no task (M4)", [spent.state, spent.state === "refused" && spent.message.length > 0, watch.some((c) => c[0] === "HGETALL" && c[1] === `nl:crm:tasks:${realStore.statsId}`)], ["refused", true, false]);
  await redisPipeline([["SET", studioCount()!, "0"]]);
  const read = await agendaData(realStore, "2026-11-04");
  is("with room, it reads the tasks and counts what three people's tasks can weigh, and nothing for its small rows (round 5, M1)", [read.state, Number((await redisPipeline([["GET", studioCount()!]]))[0])], ["ok", agendaReadUnits(3)]);
  is("a store with one person's tasks counts nothing beyond its page; 1,000 people count at most AGENDA_UNITS", [agendaReadUnits(1), agendaReadUnits(3), agendaReadUnits(1_000), AGENDA_UNITS], [0, 1, 2, 5]);
  await redisPipeline([["SET", studioCount()!, String(allowanceFor(realStore, "studio") - 3)]]);
  const tooMany = await countUnits(realStore, 5);
  is("asking more than are left says how many this needs, how many were left by the figure's own count, and when they come back (round 7, M2)", [tooMany.ok, !tooMany.ok && /^This needs 5 of your studio requests, and only 3 are left\. This opens again (with your next billing month, )?on [A-Z][a-z]+ \d+(, \d{4})? \(UTC\)\.$/.test(tooMany.message)], [false, true]);
  await redisPipeline([["SET", studioCount()!, String(allowanceFor(realStore, "studio"))]]);
  const none = await countUnits(realStore, 250);
  is("none left, said as such (round 7, L3)", !none.ok && none.message.startsWith("This needs 250 of your studio requests, and none are left. This opens again"), true);
  const never = await countUnits(realStore, 1_500);
  is("more than the whole month's figure: the figure's own words, with its number and when it comes back", !never.ok && never.message.startsWith("Your studio's requests for this month are used: 300 studio requests. This opens again"), true);
  await redisPipeline([["SET", studioCount()!, "0"]]);
  const before = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "INCRBY")) throw new Error("down");
    return before(commands);
  }) as typeof redis.pipeline;
  const unread = await countUnits(realStore, 5);
  redis.pipeline = before;
  is("when the count cannot be read, it says so, never how many are left (round 7, M2)", [!unread.ok && unread.reason, !unread.ok && unread.message.includes("left")], ["unknown", false]);
  is("one sentence, with how many this needs and how many are left (round 6, L1); a refusal keeps its reason", [!tooMany.ok && tooMany.reason], ["used"]);
  await redisPipeline([["SET", studioCount()!, "0"]]);

  part("A store with imported buyers only (round 7, M1)");
  const importedOnly = { statsId: "ppstats", handle: "ppshop", previousHandles: [], currency: "usd", pastBuyers: true } as unknown as Store;
  await redisPipeline([["ZADD", "nl:ppsell:sales:ppstats", 1, "ORDER0000000001"]]);
  watch.length = 0;
  const importedAsked: number[] = [];
  await buyerLedger(importedOnly, async (units) => { importedAsked.push(units); return true; });
  is("reads no sales, so counts none and asks nothing of the PayPal sales kept", [importedAsked.length === 0 || importedAsked.every((u) => u === 0), watch.some((c) => c[0] === "ZCARD")], [true, false]);
  await redisPipeline([["DEL", "nl:ppsell:sales:ppstats", "nl:stats:ppstats:ledger"]]);

  part("A store selling with PayPal (round 5, H1)");
  const paypalShop = { statsId: "ppstats", handle: "ppshop", previousHandles: [], currency: "usd", paypalSeller: "SELLER1" } as unknown as Store;
  const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${String.fromCharCode(97 + i)}`, "v".repeat(200)]));
  const seed: (string | number)[][] = [];
  for (let i = 0; i < 300; i++) {
    const order = `ORDER${String(i).padStart(10, "0")}`;
    seed.push(["SET", `nl:ppsell:paid:${order}`, JSON.stringify({ store: "ppstats", order, capture: `CAP${i}`, email: `buyer${i}@example.com`, product: "p1", cents: 100, currency: "usd", at: 1_700_000_000 + i, handle: "ppshop", meta })]);
    seed.push(["ZADD", "nl:ppsell:sales:ppstats", 1_700_000_000 + i, order]);
    if (i < 50) seed.push(["ZADD", "nl:ppsell:refunded:ppstats", 1_700_000_000 + i, order]);
  }
  await redisPipeline(seed);
  const paypalAsked: number[] = [];
  watch.length = 0;
  const paypalLedger = await buyerLedger(paypalShop, async (units) => { paypalAsked.push(units); return true; });
  is("its PayPal sales and refunds are counted from how many are kept, before they are read, with no Stripe part (the 50 refunded are not buyers)", [paypalAsked, paypalLedger.buyers.size], [[ledgerUnits(ledgerReadBytes({ imported: 0, paypalSales: 300, paypalRefunds: 50 }))], 250]);
  is("which counts more than what was read: 300 records and 50 refunds of about 5 KB", ledgerUnits(ledgerReadBytes({ imported: 0, paypalSales: 300, paypalRefunds: 50 })) * 1_000_000 >= 350 * 5_300, true);
  is("the refunds are read in one MGET, never one GET each", [watch.filter((c) => c[0] === "GET" && c[1].startsWith("nl:ppsell:paid:")).length, watch.filter((c) => c[0] === "MGET").length], [0, 2]);
  // A creator who sold through PayPal and disconnected it keeps those sales, read with the Stripe sales (round 6, H1).
  const stripeOnly = { statsId: "ppstats", handle: "ppshop", previousHandles: [], currency: "usd", stripeAccountId: "acct_pp" } as unknown as Store;
  await redisPipeline([["DEL", "nl:stats:ppstats:ledger"]]);
  const stripeAsked: number[] = [];
  const stripeRead = await buyerLedger(stripeOnly, async (units) => { stripeAsked.push(units); return false; }).then(() => "read", (error: unknown) => (error instanceof LedgerNotCounted ? "not counted" : String(error)));
  is("with Stripe on and PayPal off, the PayPal sales kept are still counted, and their refunds are not read", [stripeRead, stripeAsked], ["not counted", [BUYER_LEDGER_UNITS + ledgerUnits(ledgerReadBytes({ imported: 0, paypalSales: 300, paypalRefunds: 0 }))]]);
  redis.pipeline = pipe;

  part("One page, its fifty included kilobytes counted once (C3-112 (2))");
  // Two people's tasks weigh at the most 40,560 bytes, within the page's own fifty kilobytes; the buyers' copy, 30 KB
  // more, is not: alone each counted nothing, together they pass what the page's own request moves.
  const shared = { ...realStore, stripeAccountId: "acct_shared" } as Store;
  const tasksHash = `nl:crm:tasks:${shared.statsId}`;
  await redisPipeline([["DEL", tasksHash]]);
  for (const who of ["ann", "ben"]) await redisPipeline([["HSET", tasksHash, personKey(shared.statsId!, `${who}@example.com`), JSON.stringify([{ id: "abcdefghij", text: `Call ${who}`, due: "", assignee: "", done: false, createdAt: 1, doneAt: 0 }])]]);
  const copyOf = (rows: number) => JSON.stringify({ c: shared.currency, p: false, r: [["ann@example.com", 100, 1, "", 1], ...Array.from({ length: rows }, (_, i) => [`f${String(i).padStart(5, "0")}@example.com`, 0, 0, "direct", 0])], t: Date.now(), v: 6 });
  let filler = 0;
  while (copyOf(filler).length < 30_000) filler += 1;
  const sharedCopy = copyOf(filler);
  await redisPipeline([["SET", `nl:stats:${shared.statsId}:ledger`, sharedCopy, "EX", 600]]);
  is("each part alone fits in a request's own fifty kilobytes", [agendaReadUnits(2), ledgerUnits(sharedCopy.length), agendaReadUnits(2) + ledgerUnits(sharedCopy.length)], [0, 0, 0]);
  await redisPipeline([["SET", studioCount()!, "0"]]);
  const together = await agendaData(shared, "2026-11-04", new IncludedBytes());
  const countedTogether = Number((await redisPipeline([["GET", studioCount()!]]))[0]);
  is("together on one page, the copy past what the tasks left is counted a studio request, and read", [together.state, together.state === "ok" && together.rows.some((row) => row.email === "ann@example.com"), countedTogether], ["ok", true, 1]);
  // The page looking a task's person up (?who=) reads the buyers before its agenda reads them again: one page, one budget.
  await redisPipeline([["SET", studioCount()!, "0"]]);
  const pageBytes = new IncludedBytes();
  const lookup = countLedger(shared);
  const looked = await addressForPerson(shared, personKey(shared.statsId!, "ann@example.com"), lookup.count, pageBytes);
  const afterLookup = Number((await redisPipeline([["GET", studioCount()!]]))[0]);
  await agendaData(shared, "2026-11-04", pageBytes);
  const afterAgenda = Number((await redisPipeline([["GET", studioCount()!]]))[0]);
  is("the lookup reads the copy within the page's own bytes; the agenda's tasks and its own reading of the copy, past them, are counted", [looked, afterLookup, afterAgenda], ["ann@example.com", 0, 2]);
  await redisPipeline([["DEL", tasksHash, `nl:stats:${shared.statsId}:ledger`], ["SET", studioCount()!, "0"]]);

  part("The agenda's count of people with tasks reads the CRM's own tasks hash (round 7)");
  is("tasksKept reads the hash lib/crm.ts keeps the tasks in, by the same key", readFileSync("lib/crm.ts", "utf8").includes("const tasksKey = (statsId: string) => `nl:crm:tasks:${statsId}`;") && readFileSync("lib/person-agenda-read.ts", "utf8").includes("`nl:crm:tasks:${statsId}`"), true);

  part("On the buyers page");
  const page = readFileSync("app/studio/people/page.tsx", "utf8");
  is("a named section, waited for without holding the page", page.includes('<Suspense fallback={<TasksAgendaWaiting />}>') && page.includes('aria-labelledby="agenda-title"') && page.includes('aria-busy="true"'), true);
  is("each group under its own heading with its count", list.includes("<h3 className=\"text-base font-semibold text-ink\">{`${group.title} (${group.rows.length + group.more})`}</h3>"), true);
  is("a row opens the person's page by their key", readFileSync("lib/person-agenda-read.ts", "utf8").includes("studioPath(store, `who=${row.person}`, \"people\")"), true);
  is("the page reads that key again among the buyers, and says when it is not there", page.includes("addressForPerson(store, who, lookupLedger.count, included)") && page.includes("That person is not among your buyers as last read from your Stripe account, which can be up to an hour ago."), true);
  // The buyers' copy is kept an hour (lib/segments.ts LEDGER_SECONDS; Claude 1 on #3226): never "read just now".
  is("the page never says the buyers were read just now", page.includes("buyers read from your Stripe account just now"), false);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the privacy policy names every reader of the buyers' copy: an email narrowed, the task agenda and a buyer looked up", privacy.includes("When a creator narrows an email to some of their buyers, opens their task agenda or looks a buyer up, we read their sales once and keep that copy of who bought what for one hour"), true);
  is("someone not found is said to be so", list.includes("About a person we could not find among your Stripe buyers"), true);
  is("the agenda says what a person's page lets you do: mark done or remove, not change", page.includes("Open a person to mark one done or remove it.") && !page.includes("mark one done or change it"), true);
  // A task may be about a list subscriber, not only a buyer (C3-112 (2), light).
  is("its count is of tasks across the people in the store, not only its buyers", page.includes("open ${open === 1 ? \"task\" : \"tasks\"} across the people in your store. Open a person") && !page.includes("across your buyers"), true);
  is("when the tasks or the sales records cannot be read, it says so, never blaming Stripe for the store's own records (Claude 5 on #2270)", page.includes("tasks could not be read just now. Nothing was changed.") && page.includes("Your sales records could not be read just now, so who each task is about is not shown."), true);
  is("only the shown rows' people are looked up, on any of the days", readFileSync("lib/person-agenda-read.ts", "utf8").includes("const persons = new Set(agenda.rows.map((row) => row.person));"), true);
  is("the groups made for each day the creator's may be", readFileSync("lib/person-agenda-read.ts", "utf8").includes("agendaForDays(all, daysAround(today))") && page.includes("<TasksAgendaList rows={data.rows} days={data.days} serverDay={today}"), true);

  done();
}

void main();
