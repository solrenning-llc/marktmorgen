/**
 * 639 [GL7](4), unit 1: companies as records in the CRM
 * (lib/crm-companies.ts, app/api/store/companies/route.ts). A name, a
 * website and a note, never cut; one name once; the people linked by their
 * key, never their address, each at one company at most; room taken before
 * writing; a deleted person taken off every company; through the real
 * route, session and store.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/companies/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { forgetCrmPerson } from "@/lib/crm";
import {
  COMPANY_REFUSALS,
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
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; companies?: Company[]; company?: Company | null };

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
  is("every refusal says what to do", Object.values(COMPANY_REFUSALS).every((words) => /^(Type|You|Keep|Your|A company|That)/.test(words)), true);

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
  const [room] = await redisPipeline([["HGET", dataKey(store)!, "crm:co"]]);
  is("its room in the store's data room taken first", Number(room) > 0, true);
  is("a name taken is refused, saying what to do", [(await post({ action: "add", name: "NORTH SCHOOL" })).body.error, (await post({ action: "add", name: "NORTH SCHOOL" })).body.message], ["taken", COMPANY_REFUSALS.taken]);
  is("linked by key", (await post({ action: "link", id, person: ann })).body.companies?.[0].people, [ann]);
  is("where that person works, with the companies to choose from", [(await get(`?person=${ann}`)).company?.name, (await get(`?person=${ann}`)).companies], ["North School", [{ id, name: "North School" }]]);
  is("an address is not a key", (await post({ action: "link", id, person: "ann@example.com" })).body.error, "unknown");

  part("A person deleted goes from every company");
  await forgetCrmPerson(statsId, ann, "ann@example.com");
  is("no longer linked", (await readCompanies(statsId))[0].people, []);
  is("the company stays", (await readCompanies(statsId)).map((c) => c.name), ["North School"]);

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
