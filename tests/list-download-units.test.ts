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
import { importContactRows, leadsKey } from "@/lib/contacts";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { allowanceUsed, forceAllowance } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { GET as leadsGet } from "@/app/api/store/leads/route";
import { GET as audienceGet } from "@/app/api/store/audience/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ORIGIN_PER_BYTE, UNIT_COST, request } from "./plan-cost-registry";
import { MAX_LEADS } from "@/lib/contact-rules";
import { LIST_CONTACTS_PER_COMMAND, LIST_READ_BYTES_PER_CONTACT, LIST_SENT_BYTES_PER_CONTACT, listDownloadHeld, listDownloadUnits } from "@/lib/list-download";

const N = 3_000;

type Store = NonNullable<Awaited<ReturnType<typeof storeForEmail>>>;
type Route = (request: NextRequest) => Promise<Response>;

async function storeWith(owner: string, handle: string, contacts: number): Promise<{ store: Store; session: string }> {
  await claimHandle(owner, handle, "R31 List", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const rows = Array.from({ length: contacts }, (_, i) => ({ email: `person${i}@example.com`, name: `Person Number ${i}`, tags: ["webinar", "spring"], consent: "agreed" as const }));
  for (let i = 0; i < rows.length; i += 500) await importContactRows(store.listId!, rows.slice(i, i + 500), store);
  return { store: (await storeForEmail(owner))!, session: await openSession(owner) };
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
    const body = new TextEncoder().encode(await response.text()).length;
    redis.pipeline = pipeline;
    const taken = (await allowanceUsed(store, "studio")) - before;
    return { status: response.status, commands, bytes, sent: body, walked, taken };
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

  part("The units pay for the reads and the file at every size, up to MAX_LEADS, by the registry's prices");
  for (const contacts of [0, 1, N, MAX_LEADS]) {
    const sent = contacts * LIST_SENT_BYTES_PER_CONTACT;
    const commands = Math.ceil(contacts / LIST_CONTACTS_PER_COMMAND) + 20;
    const units = listDownloadUnits(contacts, sent);
    const cost = costOf(commands, contacts * LIST_READ_BYTES_PER_CONTACT + sent, sent);
    console.log(`${contacts} contacts: ${units} units ($${(units * UNIT_COST.studio).toFixed(5)}) for $${cost.toFixed(5)}; held first ${listDownloadHeld(contacts)}`);
    is(`${contacts} contacts: the units pay for it`, units * UNIT_COST.studio >= cost, true);
    is(`${contacts} contacts: what is held first is never less`, listDownloadHeld(contacts) >= units, true);
  }

  part("Control: an empty list still downloads, for a unit or two");
  redis.clear();
  const empty = await storeWith("r31-empty@example.com", "rthirtyoneempty", 0);
  const nothing = await download(leadsGet, "/api/store/leads", empty.store, empty.session);
  is("answered with the file", nothing.status, 200);
  is("a unit or two of the studio figure", nothing.taken >= 1 && nothing.taken <= 2, true);
  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
