import type { NextRequest } from "next/server";
import {
  COMPANIES_REQUEST_UNITS,
  COMPANY_REFUSALS,
  type CompanyRefusal,
  MAX_COMPANY_NAME,
  MAX_COMPANY_NOTE,
  MAX_COMPANY_PEOPLE,
  addCompany,
  changeCompanies,
  companyOf,
  dropCompany,
  editCompany,
  linkPerson,
  newCompanyId,
  readCompanies,
  readCompanyInput,
  restoreCompany,
  unlinkPerson,
} from "@/lib/crm-companies";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { countStudio, jsonAccess } from "@/lib/studio-route";
import type { Store } from "@/lib/store";

/**
 * Companies in the CRM: 639 [GL7](4), unit 1. GET lists every company, or
 * `?person=<key>` the one that person works at. POST `{ action: "add", name,
 * website?, note? }`, `{ action: "edit", id, name, website?, note? }` (a
 * website or a note left out stays as it is),
 * `{ action: "remove", id }`, `{ action: "restore", name, website?, note?,
 * people }` (a delete undone, in one change), `{ action: "link", id, person }` (moving them
 * from any other company) or `{ action: "unlink", person }`. The same
 * permission as the deals and the tasks (orders): owner, Admin, Support.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };
const PERSON = /^[0-9a-f]{32}$/;
/**
 * The studio requests a companies request counts besides the one its access
 * already took (COMPANIES_REQUEST_UNITS): it reads every company, about a
 * megabyte at the most. Null when they are taken, or the refusal to answer.
 */
async function countRead(store: Store): Promise<Response | null> {
  const counted = await countStudio(store, null, COMPANIES_REQUEST_UNITS - 1);
  if (counted.ok) return null;
  return Response.json({ ok: false, error: counted.reason === "used" ? "studio_used" : "unavailable", message: counted.message }, { status: counted.reason === "used" ? 429 : 503 });
}

const MAX_BODY_BYTES = (MAX_COMPANY_NAME + 200 + MAX_COMPANY_NOTE) * 6 + MAX_COMPANY_PEOPLE * 40 + 1_000;

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "orders");
  if (access instanceof Response) return access;
  const store = access.store;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  const person = request.nextUrl.searchParams.get("person") ?? "";
  if (person && !PERSON.test(person)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  try {
    const refused = await countRead(store);
    if (refused) return refused;
    const companies = await readCompanies(store.statsId);
    if (person) {
      return Response.json({ ok: true, company: companyOf(companies, person), companies: companies.map(({ id, name }) => ({ id, name })) }, { headers: NO_STORE });
    }
    return Response.json({ ok: true, companies }, { headers: NO_STORE });
  } catch (error) {
    console.error("reading companies failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "orders", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const statsId = store.statsId;
  if (!statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  // Taken as sent, never cut: a record that cannot be read is deleted by the exact id the page showed (round 4, L3).
  const id = typeof body.id === "string" && body.id.length <= 512 ? body.id : "";
  const person = typeof body.person === "string" ? body.person : "";
  const refuse = (error: CompanyRefusal) => Response.json({ ok: false, error, message: COMPANY_REFUSALS[error] }, { status: error === "unknown" ? 404 : error === "busy" ? 409 : 400 });
  try {
    let result;
    let refused: Response | null;
    if (body.action === "add" || body.action === "edit") {
      const input = readCompanyInput(body);
      if (!input.ok) return refuse(input.error);
      // The new company's id is made here and sent back, so the screen links the person to this one, never to one
      // another tab added at the same moment.
      const madeId = newCompanyId();
      // An edit changes only what it sends: a website or a note left out stays as it is (an empty one clears it).
      const { name, website, note } = input.value;
      const edited = { name, ...(body.website === undefined ? {} : { website }), ...(body.note === undefined ? {} : { note }) };
      if ((refused = await countRead(store))) return refused;
      result = await changeCompanies(statsId, store, (companies) => (body.action === "add" ? addCompany(companies, input.value, madeId, Date.now() / 1000) : editCompany(companies, id, edited)));
      if (result.ok && body.action === "add") return Response.json({ ok: true, companies: result.companies, added: madeId }, { headers: NO_STORE });
    } else if (body.action === "remove") {
      if ((refused = await countRead(store))) return refused;
      // A record that cannot be read is deleted the same way, so the creator can free its place (round 3, L3).
      result = await changeCompanies(statsId, store, (companies, unreadable) => (unreadable.includes(id) ? { ok: true, companies, drop: [id] } : dropCompany(companies, id)));
    } else if (body.action === "link") {
      if (!PERSON.test(person)) return refuse("unknown");
      if ((refused = await countRead(store))) return refused;
      result = await changeCompanies(statsId, store, (companies) => linkPerson(companies, id, person));
    } else if (body.action === "restore") {
      // The undo of a delete: the company and its people back in one change (review A2/A3).
      const input = readCompanyInput(body);
      if (!input.ok) return refuse(input.error);
      if (!Array.isArray(body.people) || body.people.length > MAX_COMPANY_PEOPLE) return refuse("people");
      const madeId = newCompanyId();
      let skipped: string[] = [];
      if ((refused = await countRead(store))) return refused;
      result = await changeCompanies(statsId, store, (companies) => {
        const restored = restoreCompany(companies, input.value, madeId, Date.now() / 1000, body.people as unknown[]);
        if (restored.ok) skipped = restored.skipped;
        return restored;
      });
      if (result.ok) return Response.json({ ok: true, companies: result.companies, added: madeId, skipped }, { headers: NO_STORE });
    } else if (body.action === "unlink") {
      if (!PERSON.test(person)) return refuse("unknown");
      if ((refused = await countRead(store))) return refused;
      result = await changeCompanies(statsId, store, (companies) => ({ ok: true, companies: unlinkPerson(companies, person) }));
    } else {
      return Response.json({ ok: false, error: "unknown" }, { status: 400 });
    }
    return result.ok ? Response.json({ ok: true, companies: result.companies }, { headers: NO_STORE }) : refuse(result.error);
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    console.error("saving a company failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
