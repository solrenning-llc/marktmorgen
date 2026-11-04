/**
 * What the studio's pages read of the companies (639 [GL7](4)), each part
 * counted in the store's studio requests before it is read: nothing when no
 * record is kept (one HLEN); COMPANIES_READ_UNITS for reading every company
 * (tests/plan-cost-registry.ts, COMPANIES_PAGE_READ); the buyers by what
 * their reading weighs (lib/segments.ts, buyerLedger); and what the page sends
 * on, by its size as Next sends it (companiesSentUnits), before it is drawn.
 * Server only.
 */
import { type Company, COMPANIES_READ_UNITS, COMPANY_MARKUP_BYTES, COMPANY_OPTION_MARKUP_BYTES, COMPANY_PERSON_MARKUP_BYTES, companiesForPerson, companiesKept, companiesSentUnits, readCompanies, readCompaniesAndUnreadable } from "@/lib/crm-companies";
import { personAddresses } from "@/lib/person-agenda";
import { countLedger } from "@/lib/person-agenda-read";
import type { Store } from "@/lib/store";
import { countStudio } from "@/lib/studio-route";

export type Refused = { state: "refused"; message: string } | { state: "failed" };

/** The companies a person's page offers: the person's own whole, the others by id and name (companiesForPerson). */
export async function personCompanies(store: Store, person: string): Promise<{ state: "ok"; companies: Company[] } | Refused> {
  const kept = await companiesKept(store.statsId);
  if (kept === 0) return { state: "ok", companies: [] };
  const read = await countStudio(store, null, COMPANIES_READ_UNITS);
  if (!read.ok) return { state: "refused", message: read.message };
  const offered = companiesForPerson(await readCompanies(store.statsId), person);
  const sent = await countStudio(store, null, companiesSentUnits(JSON.stringify(offered), offered.length * COMPANY_OPTION_MARKUP_BYTES));
  return sent.ok ? { state: "ok", companies: offered } : { state: "refused", message: sent.message };
}

export type ShownCompany = Company & { addresses: Record<string, string> };

/** The companies page: every company with the addresses of the people at it, and the records that cannot be read. */
export async function companiesPageData(store: Store): Promise<{ state: "ok"; companies: ShownCompany[]; unreadable: string[]; people: number; addressesRead: boolean; partial: boolean; ledgerMessage: string } | Refused> {
  const kept = await companiesKept(store.statsId).catch(() => null);
  if (kept === 0) return { state: "ok", companies: [], unreadable: [], people: 0, addressesRead: true, partial: false, ledgerMessage: "" };
  const counted = await countStudio(store, null, COMPANIES_READ_UNITS).catch(() => null);
  if (!counted?.ok) return counted ? { state: "refused", message: counted.message } : { state: "failed" };
  const read = await readCompaniesAndUnreadable(store.statsId).catch(() => null);
  if (!read) return { state: "failed" };
  const people = new Set(read.companies.flatMap((c) => c.people));
  const ledger = countLedger(store);
  const known = people.size ? await personAddresses(store, people, ledger.count).catch(() => null) : null;
  const shown = read.companies.map((company) => ({ ...company, addresses: Object.fromEntries(company.people.flatMap((p) => (known?.addresses.get(p) ? [[p, known.addresses.get(p)!]] : []))) }));
  const sending = companiesSentUnits(JSON.stringify({ shown, unreadable: read.unreadable }), (shown.length + read.unreadable.length) * COMPANY_MARKUP_BYTES + people.size * COMPANY_PERSON_MARKUP_BYTES);
  const sent = await countStudio(store, null, sending).catch(() => null);
  if (!sent?.ok) return sent ? { state: "refused", message: sent.message } : { state: "failed" };
  return { state: "ok", companies: shown, unreadable: read.unreadable, people: people.size, addressesRead: !people.size || Boolean(known), partial: known?.partial ?? false, ledgerMessage: ledger.said.message };
}
