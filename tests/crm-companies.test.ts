/**
 * 639 [GL7](4), unit 1: companies as records in the CRM
 * (lib/crm-companies.ts, app/api/store/companies/route.ts). A name, a
 * website and a note, never cut; one name once; the people linked by their
 * key, never their address, each at one company at most; room taken before
 * writing; a deleted person taken off every company; through the real
 * route, session and store.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/companies/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { forgetCrmPerson } from "@/lib/crm";
import { ERASERS } from "@/lib/person-erasure";
import {
  companiesReadUnits,
  companiesRequestUnits,
  COMPANY_REFUSALS,
  companiesSentUnits,
  htmlBytes,
  sentBytes,
  SENT_TIMES,
  readCompaniesAndUnreadable,
  MAX_COMPANIES_BYTES,
  MAX_COMPANY_NOTE,
  MAX_COMPANY_RECORD_BYTES,
  MAX_COMPANY_WEBSITE,
  changeCompanies,
  companiesForPerson,
  companyNameKey,
  forgetCompanyPerson,
  restoreCompany,
  type Company,
  MAX_COMPANIES,
  MAX_COMPANY_NAME,
  MAX_COMPANY_PEOPLE,
  addCompany,
  companyOf,
  dropCompany,
  editCompany,
  linkPerson,
  parseCompany,
  readCompanies,
  readCompanyInput,
  unlinkPerson,
} from "@/lib/crm-companies";
import { personKey } from "@/lib/person-key";
import { redisPipeline } from "@/lib/redis";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { companiesPageData, personCompanies } from "@/lib/companies-read";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; companies?: Company[]; company?: Company | null; added?: string; skipped?: string[] };

async function main(): Promise<void> {
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  const base = (id: string, name: string): Company => ({ id, name, website: "", note: "", people: [], createdAt: 1 });

  part("The rules");
  is("typed, made safe", readCompanyInput({ name: "  North  School ", website: "north.example.com", note: "Buys seats each term" }), { ok: true, value: { name: "North School", website: "https://north.example.com/", note: "Buys seats each term" } });
  is("a name is needed, and is never cut", [readCompanyInput({ name: " " }), readCompanyInput({ name: "x".repeat(MAX_COMPANY_NAME + 1) })].map((r) => (r.ok ? "" : r.error)), ["name", "name"]);
  is("a website that is not one", readCompanyInput({ name: "N", website: "not a site" }), { ok: false, error: "website" });
  const one = addCompany([], { name: "North School", website: "", note: "" }, "aaaaaaaaaa", 5);
  is("added", one.ok ? one.companies.map((c) => [c.id, c.name, c.people, c.createdAt]) : one, [["aaaaaaaaaa", "North School", [], 5]]);
  const list = one.ok ? one.companies : [];
  is("one name once, in any case", addCompany(list, { name: "north school", website: "", note: "" }, "bbbbbbbbbb", 6), { ok: false, error: "taken" });
  is("at most the store's companies", addCompany(Array.from({ length: MAX_COMPANIES }, (_, i) => base(String(i).padStart(10, "0").replace(/\d/g, (d) => "abcdef0123"[Number(d)]), `C${i}`)), { name: "New", website: "", note: "" }, "ffffffffff", 1), { ok: false, error: "full" });
  is("renamed, its people kept", editCompany([{ ...list[0], people: [a] }], "aaaaaaaaaa", { name: "North Academy", website: "", note: "" }), { ok: true, companies: [{ ...list[0], name: "North Academy", people: [a] }] });
  const two = [base("aaaaaaaaaa", "North"), { ...base("bbbbbbbbbb", "South"), people: [a] }];
  const moved = linkPerson(two, "aaaaaaaaaa", a);
  is("linking moves a person: one company at most", moved.ok ? moved.companies.map((c) => c.people) : moved, [[a], []]);
  is("a company has at most its people", linkPerson([{ ...base("aaaaaaaaaa", "N"), people: Array.from({ length: MAX_COMPANY_PEOPLE }, (_, i) => i.toString(16).padStart(32, "0")) }], "aaaaaaaaaa", b), { ok: false, error: "people" });
  is("someone is linked by their key, never an address", linkPerson(two, "aaaaaaaaaa", "ann@example.com"), { ok: false, error: "unknown" });
  is("where a person works", [companyOf(two, a)?.name, companyOf(two, b)], ["South", null]);
  is("taken off every company", unlinkPerson(two, a).map((c) => c.people), [[], []]);
  is("deleted", dropCompany(two, "bbbbbbbbbb"), { ok: true, companies: [two[0]] });
  is("read back, checked again", [parseCompany({ ...two[1], people: [a, a, "nope"] })?.people, parseCompany({ ...two[1], name: "" })], [[a], null]);
  part("Text as it is typed (edge review)");
  const typedName = (name: string) => { const r = readCompanyInput({ name }); return r.ok ? r.value.name : r.error; };
  is("a name of only signs that are not drawn is no name", ["\u200b\u200b", "\u2060", "\u3164", "\u00a0\u200d", "\u0301"].map(typedName), ["name", "name", "name", "name", "name"]);
  is("a name that reads backwards from where it is shown loses its direction signs", typedName("Acme\u202e moc.live"), "Acme moc.live");
  is("half a character pair (never typed) is shown as the replacement sign, never kept broken", typedName("A\ud800B"), "A\ufffdB");
  is("an accent typed as two characters is kept as one", typedName("Cafe\u0301"), "Caf\u00e9");
  const typedNote = readCompanyInput({ name: "N", note: "a\u0085b\u009bc" });
  is("the C1 controls in a note are made spaces, like the others", typedNote.ok ? typedNote.value.note : typedNote, "a b c");
  is("emoji joined by a joiner stay as typed", typedName("Team \u{1F469}\u200d\u{1F4BB}"), "Team \u{1F469}\u200d\u{1F4BB}");
  const school = [base("aaaaaaaaaa", "Stra\u00dfe AG")];
  is("one name once, whatever the case folds to (\u00df is ss)", addCompany(school, { name: "STRASSE AG", website: "", note: "" }, "bbbbbbbbbb", 2), { ok: false, error: "taken" });
  is("one name once, typed wide or with a zero-width space", [addCompany([base("aaaaaaaaaa", "North")], { name: "\uff2e\uff2f\uff32\uff34\uff28", website: "", note: "" }, "bbbbbbbbbb", 2), addCompany([base("aaaaaaaaaa", "North School")], { name: "North\u200b School", website: "", note: "" }, "bbbbbbbbbb", 2)].map((r) => (r.ok ? "added" : r.error)), ["taken", "taken"]);
  is("one name once, with an accent typed either way", addCompany([base("aaaaaaaaaa", "Caf\u00e9 Uno")], { name: "Cafe\u0301 uno", website: "", note: "" }, "bbbbbbbbbb", 2), { ok: false, error: "taken" });
  is("the name compared is the folded one", companyNameKey("\u03a3\u0399\u03a3\u03a5\u03a6\u039f\u03a3"), companyNameKey("\u03c3\u03b9\u03c3\u03c5\u03c6\u03bf\u03c2"));
  // Round 2, L4 (the choice, recorded): Unicode's full case folding, character by character. The Turkish dotless
  // \u0131 has no folding there and stays itself, and \u0130 folds to i with a dot above, so neither is merged with
  // the plain i: names that differ only there are two names.
  is("the dotless \u0131 and the dotted \u0130 are kept apart from i, as full case folding does", [companyNameKey("Il\u0131k") === companyNameKey("Ilik"), companyNameKey("\u0130stanbul") === companyNameKey("Istanbul"), companyNameKey("IL\u0130K") === companyNameKey("il\u0069\u0307k")], [false, false, true]);
  is("the capital sharp S folds to ss too, and signs Unicode ignores when drawing never make a name differ (round 3, L2)", [companyNameKey("STRA\u1e9eE AG") === companyNameKey("strasse ag"), companyNameKey("No\u034frth") === companyNameKey("North"), companyNameKey("North\ufe0f") === companyNameKey("North"), companyNameKey("North\u{E0100}") === companyNameKey("North"), companyNameKey("North\u3164School") === companyNameKey("North School"), companyNameKey("North\u2800School") === companyNameKey("North School"), companyNameKey("North\u115fSchool") === companyNameKey("North School")], [true, true, true, true, true, true, true]);
  is("the direction marks, the soft hyphen and the zero-width space go, as in the tasks' words (round 4, L6)", typedName("A\u200ecme\u200f S\u00adchool\u200b"), "Acme School");
  // Round 2, L3: two companies kept before names were compared this way (only a folding apart) can still be edited.
  const twins = [base("aaaaaaaaaa", "Stra\u00dfe AG"), base("bbbbbbbbbb", "STRASSE AG")];
  is("a company whose name folds like another's can still have its note changed, or its name written another way", [editCompany(twins, "aaaaaaaaaa", { name: "Stra\u00dfe AG", note: "Pays by card" }).ok, editCompany(twins, "bbbbbbbbbb", { name: "Strasse AG" }).ok], [true, true]);
  is("but a new name that another company already has is still taken", editCompany(twins, "aaaaaaaaaa", { name: "strasse ag " + "x" }).ok && editCompany([...twins, base("cccccccccc", "North")], "aaaaaaaaaa", { name: "NORTH" }), { ok: false, error: "taken" });
  const kept = { ...base("aaaaaaaaaa", "North"), website: "https://north.example.com/", note: "Pays by invoice" };
  is("an edit keeps a website and a note it leaves out", editCompany([kept], "aaaaaaaaaa", { name: "North Academy" }), { ok: true, companies: [{ ...kept, name: "North Academy" }] });
  is("an edit clears one sent empty", editCompany([kept], "aaaaaaaaaa", { name: "North", website: "", note: "" }), { ok: true, companies: [{ ...kept, website: "", note: "" }] });
  is("websites with a port, or a name in another script", ["north.example.com:8080", "example.\u0440\u0444", "b\u00fccher.de"].map((website) => { const r = readCompanyInput({ name: "N", website }); return r.ok ? r.value.website : r.error; }), ["https://north.example.com:8080/", "https://example.xn--p1ai/", "https://xn--bcher-kva.de/"]);
  is("every refusal says what to do", Object.values(COMPANY_REFUSALS).every((words) => /^(Type|You|Keep|Your|A company|That|Someone)/.test(words)), true);

  part("Through the studio's route");
  redis.clear();
  const owner = "companies@example.com";
  await claimHandle(owner, "teamshop", "Team Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_co", subscriptionId: "sub_co", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const ann = personKey(statsId, "ann@example.com");
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { cookie }) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/companies", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const get = async (query = "") => (await (await GET(new NextRequest(`https://marktmorgen.com/api/store/companies${query}`, { headers: { cookie } }))).json()) as Reply;

  const added = await post({ action: "add", name: "North School", website: "north.example.com" });
  is("added", [added.status, added.body.companies?.map((c) => [c.name, c.website])], [200, [["North School", "https://north.example.com/"]]]);
  const id = added.body.companies![0].id;
  is("the new company's own id comes back, so the screen links to it and never to one added elsewhere at the same moment", added.body.added, id);
  const [room] = await redisPipeline([["HGET", dataKey(store)!, "crm:co"]]);
  is("its room in the store's data room taken first", Number(room) > 0, true);
  is("a name taken is refused, saying what to do", [(await post({ action: "add", name: "NORTH SCHOOL" })).body.error, (await post({ action: "add", name: "NORTH SCHOOL" })).body.message], ["taken", COMPANY_REFUSALS.taken]);
  is("linked by key", (await post({ action: "link", id, person: ann })).body.companies?.[0].people, [ann]);
  is("where that person works, with the companies to choose from", [(await get(`?person=${ann}`)).company?.name, (await get(`?person=${ann}`)).companies], ["North School", [{ id, name: "North School" }]]);
  is("an address is not a key", (await post({ action: "link", id, person: "ann@example.com" })).body.error, "unknown");

  part("A person deleted goes from every company");
  // The erasure runs lib/crm-companies.ts's own row (lib/person-erasure.ts, ERASERS), beside lib/crm.ts's.
  is("the erasure takes a person off the companies in its own row, never inside lib/crm.ts", ERASERS.some((e) => e.module === "lib/crm-companies.ts") && !readFileSync("lib/crm.ts", "utf8").includes("forgetCompanyPerson"), true);
  await forgetCrmPerson(statsId, ann, "ann@example.com");
  await ERASERS.find((e) => e.module === "lib/crm-companies.ts")!.run({ statsId, person: ann, store } as never, [], new Set());
  is("no longer linked", (await readCompanies(statsId))[0].people, []);
  is("the company stays", (await readCompanies(statsId)).map((c) => c.name), ["North School"]);

  part("One change at a time");
  const lock = `nl:crm:co:lock:${statsId}`;
  await redisPipeline([["SET", lock, "someone", "EX", 10]]);
  const busy = await post({ action: "add", name: "South School" });
  is("while another change is being written, a change is refused, saying so", [busy.status, busy.body.error, busy.body.message], [409, "busy", COMPANY_REFUSALS.busy]);
  is("and nothing of it is kept", (await readCompanies(statsId)).map((c) => c.name), ["North School"]);
  let threw = false;
  await forgetCompanyPerson(statsId, ann, 300).catch(() => { threw = true; });
  is("a deletion that cannot take the lock is never skipped quietly: it fails, so it is reported as not done", threw, true);
  await redisPipeline([["DEL", lock]]);
  const both = await Promise.all([post({ action: "add", name: "East School" }), post({ action: "add", name: "West School" })]);
  const names = (await readCompanies(statsId)).map((c) => c.name);
  is("two at once never write over each other: every change that went through is kept", both.filter((r) => r.status === 200).length === names.length - 1 && both.every((r) => r.status === 200 || r.body.error === "busy"), true);
  const [after] = await redisPipeline([["GET", lock]]);
  is("the lock is let go after each change", after, null);
  for (const c of await readCompanies(statsId)) if (c.name !== "North School") await post({ action: "remove", id: c.id });
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => (c[0] === "HSET" && String(c[1]).startsWith("nl:crm:co:")) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-companies-write:")))) throw new Error("down");
    return pipe(commands);
  }) as typeof redis.pipeline;
  const failed = await post({ action: "add", name: "Failing School" });
  redis.pipeline = pipe;
  const [left] = await redisPipeline([["GET", lock]]);
  is("and when a write fails too, so the next change is not refused", [failed.status >= 500, left, (await post({ action: "edit", id, name: "North School" })).status], [true, null, 200]);

  part("The room, counted as kept (edge review)");
  const slotOf = async () => Number((await redisPipeline([["HGET", dataKey(store)!, "crm:co"]]))[0] ?? 0);
  const weighs = async () => {
    const [raw] = await redisPipeline([["HGETALL", `nl:crm:co:${statsId}`]]);
    const flat = Array.isArray(raw) ? raw.map(String) : Object.entries((raw ?? {}) as Record<string, string>).flat();
    let bytes = 0;
    for (let i = 0; i + 1 < flat.length; i += 2) bytes += dataBytes([flat[i], flat[i + 1]], 1);
    return bytes;
  };
  // The write that failed above ("Failing School") kept the room it took, since it may have landed: the room counts
  // that much more than is kept, and every change below moves the room by exactly what it moves the companies by.
  const over = (await slotOf()) - (await weighs());
  is("before: the room counts what the companies weigh, and what a write that may have landed took", over > 0, true);
  const exact = async () => (await slotOf()) - (await weighs()) - over;
  const leaving = Array.from({ length: 6 }, (_, i) => personKey(statsId, `leaving${i}@example.com`));
  for (const person of leaving) await post({ action: "link", id, person });
  const withThem = await slotOf();
  for (const person of leaving) await forgetCompanyPerson(statsId, person, undefined, store);
  is("people deleted from the store give back the room their links took", [(await slotOf()) < withThem, await exact()], [true, 0]);

  part("A change whose lock ran out never writes over the next one (edge review)");
  const target = (await post({ action: "add", name: "Race School" })).body.added!;
  const other = (await post({ action: "add", name: "Other School" })).body.added!;
  const slow = personKey(statsId, "slow@example.com");
  const quick = personKey(statsId, "quick@example.com");
  let stalled = false;
  const race: { second?: Awaited<ReturnType<typeof changeCompanies>> } = {};
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const out = await pipe(commands);
    if (!stalled && commands.some((c) => c[0] === "HGETALL" && c[1] === `nl:crm:co:${statsId}`)) {
      stalled = true;
      // The first change is held up past its lock's 10 seconds; the next one takes the lock and goes through.
      await pipe([["DEL", lock]]);
      redis.pipeline = pipe;
      race.second = await changeCompanies(statsId, store, (companies) => linkPerson(companies, target, quick));
    }
    return out;
  }) as typeof redis.pipeline;
  const first = await changeCompanies(statsId, store, (companies) => linkPerson(companies, other, slow));
  redis.pipeline = pipe;
  const raced = await readCompanies(statsId);
  is("the late change is refused as busy and writes nothing; the one that went through is kept", [first, race.second?.ok, raced.find((c) => c.id === target)?.people, raced.find((c) => c.id === other)?.people], [{ ok: false, error: "busy" }, true, [quick], []]);
  is("and the room counts what is kept", await exact(), 0);

  part("The room is moved by difference, never set to a total read outside the lock (round 2, M1)");
  // A change grows the companies, loses its lock just before its write (which so does not land), and the next
  // change, which grows them too, runs while the first is still finishing: what each one took or gave back stays its own.
  const grower = personKey(statsId, "grower@example.com");
  let lost = false;
  let late: Promise<unknown> | null = null;
  const lateChange = () => changeCompanies(statsId, store, (companies) => addCompany(companies, { name: "Late School", website: "", note: "n".repeat(300) }, "abcdef0123", 1));
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!lost && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-companies-write:"))) {
      lost = true;
      await pipe([["DEL", lock]]);
      return pipe(commands);
    }
    const out = await pipe(commands);
    // Whatever the first change reads after its lost write, the next one goes through meanwhile.
    if (lost && !late && commands.some((c) => c[0] === "HGETALL" && c[1] === `nl:crm:co:${statsId}`)) {
      redis.pipeline = pipe;
      late = lateChange();
      await late;
    }
    return out;
  }) as typeof redis.pipeline;
  const lostWrite = await changeCompanies(statsId, store, (companies) => linkPerson(companies, target, grower));
  redis.pipeline = pipe;
  if (!late) await lateChange();
  const afterLost = await readCompanies(statsId);
  is("the change whose lock was lost is refused and writes nothing; the next one is kept", [lostWrite, afterLost.find((c) => c.id === target)?.people.includes(grower), afterLost.some((c) => c.name === "Late School")], [{ ok: false, error: "busy" }, false, true]);
  is("and the room still counts exactly what is kept", await exact(), 0);
  for (const c of await readCompanies(statsId)) if (c.id !== id) await post({ action: "remove", id: c.id });
  is("removing what was added gives its room back", await exact(), 0);

  part("A write that fails without saying whether it landed (round 2, M1)");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-companies-write:"))) throw new Error("down");
    return pipe(commands);
  }) as typeof redis.pipeline;
  const roomBefore = await slotOf();
  const failedAdd = await post({ action: "add", name: "Never Written", note: "n".repeat(300) });
  redis.pipeline = pipe;
  const keptRoom = (await slotOf()) - roomBefore;
  is("keeps the room it took, so the room never counts less than is kept", [failedAdd.status, keptRoom > 0, await weighs() <= (await slotOf())], [500, true, true]);

  part("A record that cannot be read (round 3, L3)");
  const hashKey = `nl:crm:co:${statsId}`;
  await redisPipeline([["HSET", hashKey, "0123456789", "{not a company"]]);
  const seen = await readCompaniesAndUnreadable(statsId);
  is("it is told apart from the companies, so the creator can see it", [seen.unreadable, seen.companies.some((c) => c.id === "0123456789")], [["0123456789"], false]);
  const filled = Array.from({ length: MAX_COMPANIES - seen.companies.length - 1 }, (_, i) => base(i.toString(16).padStart(10, "a"), `Filler ${i}`));
  is("it still takes its place: the 300th company is refused while it is there", await changeCompanies(statsId, store, (companies) => ({ ok: true, companies: [...companies, ...filled, base("ffffffffff", "One More")] })), { ok: false, error: "full" });
  const roomWith = await slotOf();
  const dropped = await post({ action: "remove", id: "0123456789" });
  is("and the creator can delete it, which gives back its room", [dropped.status, (await readCompaniesAndUnreadable(statsId)).unreadable, (await slotOf()) < roomWith], [200, [], true]);
  is("an id that is neither a company nor a record kept is still unknown", (await post({ action: "remove", id: "9999999999" })).body.error, "unknown");
  const longId = "an-imported-record-with-a-long-field-name";
  await redisPipeline([["HSET", hashKey, longId, "not json either"]]);
  const longGone = await post({ action: "remove", id: longId });
  is("one kept under an id longer than a company's is deleted by that exact id (round 4, L3)", [longGone.status, (await readCompaniesAndUnreadable(statsId)).unreadable], [200, []]);
  const editor = readFileSync("components/companies-editor.tsx", "utf8");
  is("only words in the editor's status region; the Undo button is outside it (round 4, L4)", /<p role="status"[^>]*>\s*\{gone \? `Deleted \$\{gone\.name\}\. Its people are still in your store\.` : putBack\}\s*<\/p>/.test(editor) && editor.indexOf("onClick={() => void undo()}") > editor.indexOf('<p role="status"'), true);
  const personScreen = readFileSync("components/person-company.tsx", "utf8");
  is("only words in a person's company status region too; Undo is outside it (round 5, L2)", /<p role="status"[^>]*>\s*\{left \? `Taken off \$\{left\.name\}\.` : ""\}\s*<\/p>/.test(personScreen) && personScreen.indexOf("onClick={() => void undo()}") > personScreen.indexOf('<p role="status"'), true);
  is("each company's name written again in the buttons' names is counted in what the page sends (round 5, L3)", readFileSync("lib/companies-read.ts", "utf8").includes("2 * htmlBytes(company.name)") && htmlBytes("A & B") === 9, true);
  is("the companies page shows each such record with a button to delete it", editor.includes("Records that can't be read") && editor.includes("aria-label={`Delete unreadable record ${i + 1}`}") && readFileSync("app/studio/companies/page.tsx", "utf8").includes("unreadable={data.unreadable}"), true);

  part("What reading the companies costs (round 2, M2)");
  const worst = parseCompany({ id: "abcdef0123", name: "\u4e2d".repeat(MAX_COMPANY_NAME), website: "https://example.com/" + "a".repeat(MAX_COMPANY_WEBSITE - 21), note: "\u4e2d".repeat(MAX_COMPANY_NOTE), people: Array.from({ length: MAX_COMPANY_PEOPLE }, (_, i) => i.toString(16).padStart(32, "0")), createdAt: 4_102_444_800 });
  const quoted = parseCompany({ ...worst, name: '"'.repeat(MAX_COMPANY_NAME), note: "\\".repeat(MAX_COMPANY_NOTE) });
  is("the heaviest company kept weighs no more than MAX_COMPANY_RECORD_BYTES", [worst, quoted].map((c) => c !== null && Buffer.byteLength(JSON.stringify(c)) <= MAX_COMPANY_RECORD_BYTES), [true, true]);
  is("so every company weighs no more than MAX_COMPANIES_BYTES", MAX_COMPANIES_BYTES >= MAX_COMPANIES * (MAX_COMPANY_RECORD_BYTES + 10), true);
  const route = readFileSync("app/api/store/companies/route.ts", "utf8");
  is("every companies request counts what reading them costs, from how many are kept, before it reads them all", [companiesRequestUnits(MAX_COMPANIES) > 1, route.includes("const counted = await countUnits(store, companiesRequestUnits(kept));"), (route.match(/if \(\(refused = await countRead\(store\)\)\) return refused;\n(?:\s+\/\/[^\n]*\n)*\s+result = await changeCompanies\(/g) ?? []).length, route.includes("const refused = await countRead(store);\n    if (refused) return refused;\n    const companies = await readCompanies(")], [true, true, 5, true]);
  const reader = readFileSync("lib/companies-read.ts", "utf8");
  is("the companies page counts its reading first, the buyers only when they are read, and what it sends by its size before drawing it (round 3, M1/M2)", [reader.indexOf("countUnits(store, companiesReadUnits(kept))") < reader.indexOf("readCompaniesAndUnreadable(store.statsId)"), reader.includes("personAddresses(store, people, ledger.count)"), reader.includes("const sent = await countUnits(store, sending)"), readFileSync("app/studio/companies/page.tsx", "utf8").includes("const data = await companiesPageData(store);")], [true, true, true, true]);
  is("what is sent is measured as Next sends it: nothing within the page's own 50 KB, then one studio request a megabyte (round 5, M1)", [companiesSentUnits("", 0), companiesSentUnits("x".repeat(20_000), 0), companiesSentUnits("x".repeat(300_000), 100_000), companiesSentUnits("x".repeat(1_000_000), 0)], [0, 0, 1, 3]);
  const ampName = JSON.stringify({ name: "&".repeat(80) });
  is("a name full of & is sent as more than ten bytes each (round 4, M1)", [sentBytes(ampName) > 10 * 80, sentBytes(ampName) <= SENT_TIMES * ampName.length], [true, true]);
  const slim = companiesForPerson([{ ...base("aaaaaaaaaa", "North"), note: "Big note", website: "https://north.example.com/", people: [b] }, { ...base("bbbbbbbbbb", "South"), note: "Theirs", people: [a] }], a);
  is("a person's page sends their own company whole and every other by its id and name", slim.map((c) => [c.name, c.note, c.website, c.people]), [["North", "", "", []], ["South", "Theirs", "", [a]]]);
  is("as the people page does, through personCompanies (round 3, M2)", readFileSync("app/studio/people/page.tsx", "utf8").includes("personCompanies(store, profile.person)") && reader.includes("const offered = companiesForPerson(await readCompanies(store.statsId), person);"), true);

  part("The pages counted before they read, on the real store (round 4, M4 and L5)");
  const watched: string[][] = [];
  const realPipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const c of commands) watched.push(c.map(String));
    return realPipe(commands);
  }) as typeof redis.pipeline;
  const studioKey = () => redis.keys().find((k) => k.startsWith("nl:allow:studio:"))!;
  const readsAll = () => watched.some((c) => c[0] === "HGETALL" && c[1] === `nl:crm:co:${statsId}`);
  // A few companies stay inside the page's own request (round 5, M1); twenty full ones need more.
  is("reading a few companies counts nothing beyond the page; twenty full ones one more; three hundred two", [companiesReadUnits(3), companiesReadUnits(20), companiesReadUnits(MAX_COMPANIES)], [0, 1, 2]);
  const fillers = Array.from({ length: 20 }, (_, i) => ({ ...base(`f${i.toString(16).padStart(9, "0")}`, `Filler School ${i}`), note: "n".repeat(MAX_COMPANY_NOTE), website: "https://example.com/" + "w".repeat(150) }));
  await changeCompanies(statsId, store, (companies) => ({ ok: true, companies: [...companies, ...fillers] }));
  await redisPipeline([["SET", studioKey(), String(allowanceFor(store, "studio"))]]);
  watched.length = 0;
  const pageSpent = await companiesPageData(store);
  const personSpent = await personCompanies(store, ann);
  is("with no studio request left, the companies page and a person's page with twenty companies are refused with the allowance's sentence and read no company", [pageSpent.state, pageSpent.state === "refused" && pageSpent.message.length > 0, personSpent.state, readsAll()], ["refused", true, "refused", false]);
  await redisPipeline([["SET", studioKey(), "0"]]);
  const pageRead = await companiesPageData(store);
  is("with room, the page reads them and counts its reading and what it sends", [pageRead.state, Number((await redisPipeline([["GET", studioKey()]]))[0]) >= companiesReadUnits(20) + 1], ["ok", true]);
  const otherOwner = "nocompanies@example.com";
  await claimHandle(otherOwner, "nocompanies", "No Companies", "");
  await ensureStatsId(otherOwner);
  await ensureStoreId(otherOwner);
  await setSubscription(otherOwner, { customerId: "cus_nc", subscriptionId: "sub_nc", active: true, tier: "creator", period: paidPeriod() });
  const bare = (await storeForEmail(otherOwner))!;
  watched.length = 0;
  const bareKeysBefore = redis.keys().filter((k) => k.startsWith("nl:allow:studio:")).length;
  const barePage = await companiesPageData(bare);
  const barePerson = await personCompanies(bare, personKey(bare.statsId!, "ann@example.com"));
  is("a store with no company counts nothing and reads no hash (L5)", [barePage.state, barePerson.state === "ok" && barePerson.companies.length, redis.keys().filter((k) => k.startsWith("nl:allow:studio:")).length, watched.some((c) => c[0] === "HGETALL")], ["ok", 0, bareKeysBefore, false]);
  redis.pipeline = realPipe;

  part("The studio requests a companies request takes (round 3, L6; round 5, M1)");
  const usedKey = () => redis.keys().find((k) => k.startsWith("nl:allow:studio:"));
  const used = async () => { const k = usedKey(); return k ? Number((await redisPipeline([["GET", k]]))[0] ?? 0) : 0; };
  const kept20 = (await readCompanies(statsId)).length;
  const beforeOne = await used();
  await post({ action: "add", name: "Counted School" });
  is("with twenty companies, one change takes its own studio request and what reading and sending them costs", (await used()) - beforeOne, 1 + companiesRequestUnits(kept20));
  const beforeGet = await used();
  await get();
  is("and so does a reading of them", (await used()) - beforeGet, 1 + companiesRequestUnits(kept20 + 1));
  const limit = allowanceFor(store, "studio");
  await redisPipeline([["SET", usedKey()!, String(limit - 1)]]);
  const spent = await post({ action: "add", name: "Over School" });
  is("when only the request itself fits, the change is refused as used, says it needs more than is left, and keeps nothing", [spent.status, spent.body.error, (await readCompanies(statsId)).some((c) => c.name === "Over School")], [429, "studio_used", false]);
  await redisPipeline([["SET", usedKey()!, "0"]]);
  // The request's own studio request is counted, then what reading them costs cannot be (round 7, L1): unavailable, 503.
  const counting = redis.pipeline.bind(redis);
  let increments = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "INCRBY") && ++increments === 2) throw new Error("down");
    return counting(commands);
  }) as typeof redis.pipeline;
  const uncounted = await post({ action: "add", name: "Uncounted School" });
  redis.pipeline = counting;
  is("when what reading them costs cannot be counted, the change answers 503 unavailable, never 429 used, and keeps nothing (round 6, L2; round 7, L1)", [uncounted.status, uncounted.body.error, (await readCompanies(statsId)).some((c) => c.name === "Uncounted School")], [503, "unavailable", false]);
  for (const c of await readCompanies(statsId)) if (c.name === "Counted School" || c.name.startsWith("Filler School")) await post({ action: "remove", id: c.id });
  const beforeSmall = await used();
  await post({ action: "add", name: "Small School" });
  is("with a few companies, a change takes only its own studio request", (await used()) - beforeSmall, 1);
  for (const c of await readCompanies(statsId)) if (c.name === "Small School") await post({ action: "remove", id: c.id });

  part("An edit through the route keeps what it leaves out (edge review)");
  await post({ action: "edit", id, name: "North School", website: "north.example.com", note: "Pays by invoice" });
  const renamed = await post({ action: "edit", id, name: "North Academy" });
  is("renamed, its website and note kept", renamed.body.companies?.find((c) => c.id === id) && [renamed.body.companies.find((c) => c.id === id)!.name, renamed.body.companies.find((c) => c.id === id)!.website, renamed.body.companies.find((c) => c.id === id)!.note], ["North Academy", "https://north.example.com/", "Pays by invoice"]);
  await post({ action: "edit", id, name: "North School", website: "", note: "" });

  part("A delete undone (review A2/A3)");
  is("the rule: the company back with its people, except who is at another company now", (() => { const r = restoreCompany([{ ...base("bbbbbbbbbb", "South"), people: [b] }], { name: "North", website: "", note: "" }, "cccccccccc", 9, [a, b, "nope", a]); return r.ok ? [r.companies.find((c) => c.id === "cccccccccc")?.people, r.skipped] : r; })(), [[a], [b]]);
  const ben = personKey(statsId, "ben@example.com");
  const tmp = await post({ action: "add", name: "Temp School" });
  const tmpId = tmp.body.added!;
  await post({ action: "link", id: tmpId, person: ann });
  await post({ action: "link", id: tmpId, person: ben });
  await post({ action: "remove", id: tmpId });
  await post({ action: "link", id, person: ben });
  const restored = await post({ action: "restore", name: "Temp School", website: "", note: "", people: [ann, ben] });
  const again = (await readCompanies(statsId)).find((c) => c.id === restored.body.added);
  is("put back in one change: who is free comes back, who moved since stays where they went, and the screen is told", [restored.status, again?.name, again?.people, restored.body.skipped, (await readCompanies(statsId)).find((c) => c.id === id)?.people.includes(ben)], [200, "Temp School", [ann], [ben], true]);
  is("too many people at once is refused", (await post({ action: "restore", name: "Other", people: Array.from({ length: 51 }, () => ann) })).body.error, "people");
  await post({ action: "remove", id: restored.body.added });
  await post({ action: "unlink", person: ben });

  part("Changed and removed");
  is("renamed", (await post({ action: "edit", id, name: "North Academy" })).body.companies?.[0].name, "North Academy");
  is("a company that is gone", [(await post({ action: "edit", id: "ffffffffff", name: "X" })).status, (await post({ action: "remove", id: "ffffffffff" })).body.error], [404, "unknown"]);
  is("removed", [(await post({ action: "remove", id })).body.companies, await readCompanies(statsId)], [[], []]);
  is("an action that is not one", (await post({ action: "merge" })).body.error, "unknown");
  const stranger = await post({ action: "add", name: "Sneaky" }, {});
  is("no session: refused, and nothing kept", [stranger.status >= 400 && stranger.status < 500, await readCompanies(statsId)], [true, []]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
