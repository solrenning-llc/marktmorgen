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

async function main(){
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

 done();
}
main();
