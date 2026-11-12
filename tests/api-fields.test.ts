/**
 * 630 [HN6](42): choosing the fields of an API answer with ?fields=, only
 * at the top level of each row, paging kept, a field no row has refused by
 * name, and every answer exactly as before without it.
 */
import { readFileSync } from "node:fs";
import { GET as products } from "@/app/api/v1/products/route";
import { GET as leads } from "@/app/api/v1/leads/route";
import { makeKey } from "@/lib/api-keys";
import { FIELD_NAME_MAX, MAX_FIELDS_ASKED, apiOkFields, fieldsAsked, pickFields } from "@/lib/api-fields";
import { LEAD_FIELDS, MEMBER_FIELDS, PRODUCT_FIELDS, members } from "@/lib/api-read";
import { CODE_FIELDS, codeOut } from "@/lib/api-codes";
import type { DiscountCode } from "@/lib/discount";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("What is asked");
  const ask = (q: string) => fieldsAsked(`https://marktmorgen.com/api/v1/leads${q}`);
  is("nothing asked: the answer as before", ask(""), { ok: true, fields: null });
  is("names, trimmed, each once", ask("?fields=email,%20agreed,email"), { ok: true, fields: ["email", "agreed"] });
  is("empty, or a name that cannot be one, refused", [ask("?fields=").ok, ask("?fields=,,").ok, ask("?fields=Email").ok, ask("?fields=a.b").ok], [false, false, false, false]);
  is(`at most ${MAX_FIELDS_ASKED}`, ask(`?fields=${Array.from({ length: MAX_FIELDS_ASKED + 1 }, (_, i) => `f${i}`).join(",")}`).ok, false);
  // What the developers page and the 400 say a name is: lowercase letters, digits and underscores, starting with a letter, up to FIELD_NAME_MAX.
  is("a name: lowercase letters, digits and underscores, starting with a letter, up to the most", [
    ask(`?fields=a${"b_9".repeat(13)}`).ok, ask(`?fields=${"a".repeat(FIELD_NAME_MAX)}`).ok, ask(`?fields=${"a".repeat(FIELD_NAME_MAX + 1)}`).ok, ask("?fields=9lives").ok, ask("?fields=_x").ok, ask("?fields=aB").ok,
  ], [true, true, false, false, false, false]);
  const devPage = readFileSync("app/developers/page.tsx", "utf8");
  is("the developers page says so, from the code's own figures", [devPage.includes("lowercase letters, digits and underscores, starting with a letter, up to {FIELD_NAME_MAX} characters"), devPage.includes("{MAX_FIELDS_ASKED} names"), devPage.includes("at most 30 names")], [true, true, false]);

  part("What is kept");
  const page = { data: [{ email: "a@example.com", agreed: true, tags: ["x"] }, { email: "b@example.com", agreed: false, tags: [] }], next: "200" };
  is("only the chosen fields of each row, in the answer's order; paging kept", pickFields(page, ["agreed", "email"]), { ok: true, body: { data: [{ email: "a@example.com", agreed: true }, { email: "b@example.com", agreed: false }], next: "200" } });
  is("one object in data, the same", pickFields({ data: { name: "Shop", handle: "shop" } }, ["name"]), { ok: true, body: { data: { name: "Shop" } } });
  is("a field no row has, named", pickFields(page, ["email", "emial"]), { ok: false, unknown: "emial" });
  is("an empty list cannot say a field is unknown, so it is kept empty", pickFields({ data: [], next: null }, ["anything"]), { ok: true, body: { data: [], next: null } });
  is("nothing asked: untouched", pickFields(page, null), { ok: true, body: page });
  const refused = apiOkFields(new Request("https://marktmorgen.com/api/v1/leads?fields=emial"), page);
  is("the refusal is a 400 that names it", [refused.status, ((await refused.json()) as { error: string }).error], [400, "unknown_field"]);

  part("Through the routes");
  const OWNER = "apifields@example.com";
  await claimHandle(OWNER, "apifields", "API Fields", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ApiFields1", subscriptionId: "sub_ApiFields1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const key = await makeKey(store.sid, "Synthetic reader");
  if (!key.ok) throw new Error("no key");
  const get = async (route: typeof products, path: string) => {
    const r = await route(new Request(`https://marktmorgen.com${path}`, { headers: { Authorization: `Bearer ${key.key}` } }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const plain = await get(products, "/api/v1/products");
  is("without fields, the products as before", [plain.status, Array.isArray(plain.body.data), "next" in plain.body], [200, true, true]);
  const bad = await get(leads, "/api/v1/leads?fields=Bad-Name");
  is("a bad name on a real route: 400 fields", [bad.status, bad.body.error], [400, "fields"]);
  const routes = ["products", "leads", "members", "students", "store", "bookings", "affiliates", "codes"];
  is("every list, Store and Bookings choose fields", routes.every((r) => readFileSync(`app/api/v1/${r}/route.ts`, "utf8").includes("apiOkFields(request,")), true);
  is("documented for developers", readFileSync("app/developers/page.tsx", "utf8").includes("/api/v1/leads?fields=email,agreed"), true);

  part("Each list's fixed fields are exactly the fields its rows are sent with, so a field asked for is checked against what is sent");
  const added = await addProduct(OWNER, "Synthetic product", "", "10");
  if (!added.ok) throw new Error("no synthetic product");
  const productRows = (await get(products, "/api/v1/products")).body.data as Record<string, unknown>[];
  is("products", Object.keys(productRows[0]), [...PRODUCT_FIELDS]);
  await ensureListId(OWNER);
  const listId = (await storeForEmail(OWNER))!.listId!;
  await redis.pipeline([["HSET", `nl:store:leads:${listId}`, "lead@example.com", JSON.stringify({ agreed: true, agreedAt: "2026-09-12T14:03:22.000Z", firstAt: "", lastAt: "", titles: [], ids: [], source: "free", unsub: false, unsubAt: "", t: "f".repeat(40), name: "Synthetic Person", tags: [], importedAt: "" })]]);
  const leadRows = (await get(leads, "/api/v1/leads")).body.data as Record<string, unknown>[];
  is("leads", Object.keys(leadRows[0]), [...LEAD_FIELDS]);
  await redis.pipeline([["HSET", "nl:cm:synthetic-fields:m", "k1", JSON.stringify({ k: "k1", e: "member@example.com", n: "Synthetic Member", h: "synthetic", dir: true, mail: true, at: 1_790_000_000 })]]);
  const memberPage = await members({ ...(await storeForEmail(OWNER))!, community: { id: "synthetic-fields" } } as Store, null, async () => async () => null);
  is("members", memberPage instanceof Response ? null : Object.keys(memberPage.data[0]), [...MEMBER_FIELDS]);
  const code = { id: "promo_Synthetic1", code: "LAUNCH20", off: { kind: "percent", percent: 20 }, timesRedeemed: 0, maxRedemptions: null, expiresAt: null, active: true, minimum: null, firstOrder: false, duration: { kind: "once" }, otherRules: false } as unknown as DiscountCode;
  is("codes", Object.keys(codeOut(code)), [...CODE_FIELDS]);

  done();
}

void main();
