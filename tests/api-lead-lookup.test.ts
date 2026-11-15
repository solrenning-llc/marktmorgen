/**
 * GET /api/v1/leads?email= (lib/api-read.ts, chargedLead): one contact of the
 * store's list by address, for the Zapier search "Find Contact by Email"
 * (zapier/index.js, find_contact). What is checked, with synthetic stores,
 * keys and list rows only:
 *
 *   - the one contact under the address is sent, read by one HGET of that
 *     address only (lowercased and trimmed as the list keeps it), never a scan
 *     of the list, with no next page;
 *   - nobody under the address is an empty page; a contact kept there that
 *     cannot be read is `unreadable: 1`, never nobody; an answer Redis gives in
 *     another shape is 502, never nobody (rule 24);
 *   - `agreed=true` leaves out one who did not agree or left;
 *   - an address that cannot be one, or a cursor with it, is refused with 400
 *     before anything is taken past the door's request or read;
 *   - it is set aside at one contact at its longest before it is read, and
 *     settled at what was read and sent; with one request left it is refused
 *     with 429 and nothing read;
 *   - the Zapier search answers through the real route: the row, nothing for
 *     nobody, and a stop with the reason for an unreadable contact.
 */
import { GET as leadsRead } from "@/app/api/v1/leads/route";
import { makeKey } from "@/lib/api-keys";
import { LEAD_LOOKUP_MOST, chargedLead } from "@/lib/api-read";
import { apiReadUnits, listPageMost } from "@/lib/api-read-rules";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require("../zapier/index.js") as {
  searches: Record<string, { operation: { perform: (z: Z, b: { authData: { api_key: string }; inputData: Record<string, unknown> }) => Promise<Record<string, unknown>[]> } }>;
  beforeRequest: ((r: Req, z: Z, b: unknown) => Req)[];
  afterResponse: ((r: Res, z: Z) => Res)[];
};
type Req = { url: string; method?: string; params?: Record<string, string | number>; headers?: Record<string, string> };
type Res = { status: number; data: unknown; content: string };
type Z = { request: (r: Req) => Promise<Res>; errors: { Error: typeof ZapierError } };
class ZapierError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

let commands: (string | number)[][] = [];
const pipeline = redis.pipeline.bind(redis);
let answer: ((batch: (string | number)[][]) => unknown[] | null) | null = null;
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  const forced = answer?.(batch);
  return forced ?? pipeline(batch);
}) as typeof redis.pipeline;

const OWNER = "lead-lookup@example.com";
const get = (key: string, query: string) => new Request(`https://marktmorgen.com/api/v1/leads${query}`, { headers: { Authorization: `Bearer ${key}` } });
const row = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ agreed: true, agreedAt: "2026-09-12T14:03:22.000Z", firstAt: "2026-09-12T14:03:22.000Z", lastAt: "", titles: ["Free Pantry Guide"], ids: ["p8w2m4q9zz"], source: "free", unsub: false, unsubAt: "", t: "f".repeat(40), name: "Dana", tags: ["vip"], importedAt: "", ...over });

function zFor(key: string): Z {
  const z: Z = {
    errors: { Error: ZapierError },
    request: async (raw: Req) => {
      let req: Req = { headers: {}, method: "GET", ...raw };
      for (const hook of app.beforeRequest) req = hook(req, z, { authData: { api_key: key }, inputData: {} });
      const url = new URL(req.url);
      for (const [name, value] of Object.entries(req.params ?? {})) url.searchParams.set(name, String(value));
      const response = await leadsRead(new Request(url.toString(), { headers: req.headers }));
      const content = await response.text();
      let data: unknown = {};
      try {
        data = JSON.parse(content);
      } catch {
        data = {};
      }
      let res: Res = { status: response.status, data, content };
      for (const hook of app.afterResponse) res = hook(res, z);
      return res;
    },
  };
  return z;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "lead-lookup", "Lead Lookup", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_LeadLookup0000", subscriptionId: "sub_LeadLookup0000", active: true, period: paidPeriod() });
  const store = async (): Promise<Store> => (await storeForEmail(OWNER))!;
  const made = await makeKey((await store()).sid!, "Synthetic reader");
  if (!made.ok) throw new Error("no synthetic key");
  const key = made.key;
  const listId = (await store()).listId!;
  await pipeline([
    ["HSET", `nl:store:leads:${listId}`, "dana@example.com", row(), "left@example.com", row({ unsub: true, unsubAt: "2026-10-01T00:00:00.000Z" }), "broken@example.com", "{not json", "other@example.com", row({ name: "Other" })],
  ]);
  const used = async () => allowanceUsed(await store(), "api");

  part("The one contact under the address, read by that address only");
  commands = [];
  let before = await used();
  const found = await leadsRead(get(key, "?email=%20Dana@Example.COM%20"));
  const body = await found.json();
  is("answered with that contact, and no next page", [found.status, body.data.length, body.data[0]?.email, body.data[0]?.name, body.next], [200, 1, "dana@example.com", "Dana", null]);
  is("the same fields as a page of the list", Object.keys(body.data[0]).sort(), ["agreed", "agreed_at", "email", "first_at", "last_at", "name", "product_ids", "products", "source", "tags", "unsubscribed", "unsubscribed_at"]);
  is("no unreadable field when it was read", "unreadable" in body, false);
  is("one HGET of that address, never a scan of the list", commands.filter((c) => String(c[1] ?? "").startsWith("nl:store:leads:")), [["HGET", `nl:store:leads:${listId}`, "dana@example.com"]]);
  const took = (await used()) - before;
  is("settled at what it read and sent: more than nothing, below one contact at its longest", took >= 1 && took <= 1 + apiReadUnits(LEAD_LOOKUP_MOST), true);
  is("one contact at its longest is less than a page", apiReadUnits(LEAD_LOOKUP_MOST) < apiReadUnits(listPageMost("leads", 200)), true);

  part("Nobody, unreadable and unknown are three different answers");
  const nobody = await (await leadsRead(get(key, "?email=nobody@example.com"))).json();
  is("nobody under the address is an empty page", [nobody.data, nobody.next, "unreadable" in nobody], [[], null, false]);
  const broken = await (await leadsRead(get(key, "?email=broken@example.com"))).json();
  is("a contact kept there that cannot be read is said, never nobody", [broken.data, broken.unreadable], [[], 1]);
  for (const [label, reply] of [["no reply", []], ["a number", [7]], ["a list", [["x"]]]] as const) {
    answer = (batch) => (batch.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:store:leads:")) ? [...reply] : null);
    const r = await leadsRead(get(key, "?email=dana@example.com"));
    answer = null;
    is(`${label} from Redis is 502 unavailable, never nobody`, [r.status, (await r.json()).error], [502, "unavailable"]);
  }
  answer = (batch) => (batch.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:store:leads:")) ? [7] : null);
  let thrown = "";
  await chargedLead(await store(), "dana@example.com", false, async () => async () => null).catch((e: Error) => { thrown = e.name; });
  answer = null;
  is("the reading itself throws on it", thrown, "UnknownReplyError");

  part("agreed=true leaves out one who left");
  const left = await (await leadsRead(get(key, "?email=left@example.com&agreed=true"))).json();
  is("one who unsubscribed is not sent", left.data, []);
  const leftAll = await (await leadsRead(get(key, "?email=left@example.com"))).json();
  is("without it, sent, said as unsubscribed", [leftAll.data.length, leftAll.data[0]?.unsubscribed], [1, true]);

  part("A request that cannot be answered is refused before anything is read");
  for (const [label, query, error] of [["an empty address", "?email=", "invalid_email"], ["no @", "?email=dana.example.com", "invalid_email"], ["too long", `?email=${"a".repeat(250)}@example.com`, "invalid_email"], ["with a cursor", "?email=dana@example.com&cursor=0", "invalid_cursor"]] as const) {
    commands = [];
    before = await used();
    const r = await leadsRead(get(key, query));
    is(`${label}: 400 ${error}`, [r.status, (await r.json()).error], [400, error]);
    is(`${label}: the list not read, only the door's request taken`, [commands.some((c) => String(c[1] ?? "").startsWith("nl:store:leads:")), (await used()) - before], [false, 1]);
  }

  part("With one request left, refused with nothing read");
  const mine = await store();
  const free = allowanceFor(mine, "api") - (await allowanceUsed(mine, "api"));
  if (free > 1) is("the month is taken down to one", (await takeAllowance(mine, "api", free - 1)).ok, true);
  commands = [];
  const refused = await leadsRead(get(key, "?email=dana@example.com"));
  is("429 monthly_limit", [refused.status, (await refused.json()).error], [429, "monthly_limit"]);
  is("the contact not read", commands.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:store:leads:")), false);
  const [, keys] = (await pipeline([["SCAN", "0", "MATCH", "nl:allow:api:*", "COUNT", 10_000]]))[0] as [string, string[]];
  if (keys.length) await pipeline([["DEL", ...keys]]);

  part("The Zapier search, through the real route");
  const search = app.searches.find_contact.operation;
  const auth = { api_key: key };
  const zfound = await search.perform(zFor(key), { authData: auth, inputData: { email: "Dana@Example.com" } });
  is("the contact found", [zfound.length, zfound[0]?.email], [1, "dana@example.com"]);
  is("nobody is nothing found", await search.perform(zFor(key), { authData: auth, inputData: { email: "nobody@example.com" } }), []);
  const unreadable = await search.perform(zFor(key), { authData: auth, inputData: { email: "broken@example.com" } }).then(() => "", (e: ZapierError) => e.code);
  is("an unreadable contact stops the run with the reason, never nothing found", unreadable, "unreadable");
  const notAddress = await search.perform(zFor(key), { authData: auth, inputData: { email: "not an address" } }).then(() => "", (e: ZapierError) => e.code);
  is("an address that is not one is the API's refusal", notAddress, "invalid_email");
  answer = (batch) => (batch.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:store:leads:")) ? [7] : null);
  const unknown = await search.perform(zFor(key), { authData: auth, inputData: { email: "dana@example.com" } }).then(() => "", (e: ZapierError) => e.code);
  answer = null;
  is("an unknown answer stops the run, never nothing found", unknown, "unavailable");

  done();
}

void main();
