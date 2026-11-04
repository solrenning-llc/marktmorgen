import type { NextRequest } from "next/server";
import {
  COMPANY_REFUSALS,
  type CompanyRefusal,
  MAX_COMPANY_NAME,
  MAX_COMPANY_NOTE,
  addCompany,
  changeCompanies,
  companyOf,
  dropCompany,
  editCompany,
  linkPerson,
  newCompanyId,
  readCompanies,
  readCompanyInput,
  unlinkPerson,
} from "@/lib/crm-companies";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";

/**
 * Companies in the CRM: 639 [GL7](4), unit 1. GET lists every company, or
 * `?person=<key>` the one that person works at. POST `{ action: "add", name,
 * website?, note? }`, `{ action: "edit", id, name, website?, note? }`,
 * `{ action: "remove", id }`, `{ action: "link", id, person }` (moving them
 * from any other company) or `{ action: "unlink", person }`. The same
 * permission as the deals and the tasks (orders): owner, Admin, Support.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };
const PERSON = /^[0-9a-f]{32}$/;
const MAX_BODY_BYTES = (MAX_COMPANY_NAME + 200 + MAX_COMPANY_NOTE) * 6 + 1_000;

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "orders");
  if (access instanceof Response) return access;
  const store = access.store;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  const person = request.nextUrl.searchParams.get("person") ?? "";
  try {
    const companies = await readCompanies(store.statsId);
    if (person) {
      if (!PERSON.test(person)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
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
  const id = typeof body.id === "string" ? body.id.slice(0, 20) : "";
  const person = typeof body.person === "string" ? body.person : "";
  const refuse = (error: CompanyRefusal) => Response.json({ ok: false, error, message: COMPANY_REFUSALS[error] }, { status: error === "unknown" ? 404 : error === "busy" ? 409 : 400 });
  try {
    let result;
    if (body.action === "add" || body.action === "edit") {
      const input = readCompanyInput(body);
      if (!input.ok) return refuse(input.error);
      // The new company's id is made here and sent back, so the screen links the person to this one, never to one
      // another tab added at the same moment.
      const madeId = newCompanyId();
      result = await changeCompanies(statsId, store, (companies) => (body.action === "add" ? addCompany(companies, input.value, madeId, Date.now() / 1000) : editCompany(companies, id, input.value)));
      if (result.ok && body.action === "add") return Response.json({ ok: true, companies: result.companies, added: madeId }, { headers: NO_STORE });
    } else if (body.action === "remove") {
      result = await changeCompanies(statsId, store, (companies) => dropCompany(companies, id));
    } else if (body.action === "link") {
      if (!PERSON.test(person)) return refuse("unknown");
      result = await changeCompanies(statsId, store, (companies) => linkPerson(companies, id, person));
    } else if (body.action === "unlink") {
      if (!PERSON.test(person)) return refuse("unknown");
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
